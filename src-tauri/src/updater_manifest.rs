//! 本地更新清单代理：解决国内直连 GitHub Releases 超时。
//!
//! 流程：
//! 1. 应用启动后在 `127.0.0.1:47865` 提供 `/latest.json`
//! 2. 仅直连可信 GitHub 地址拉取并解析官方 `latest.json`
//! 3. 镜像只用于改写清单里的 `platforms.*.url`，绝不提供版本元数据
//! 4. tauri-plugin-updater 请求本机清单，资产下载使用镜像 URL

use std::sync::OnceLock;
use std::thread;
use std::time::Duration;

use reqwest::blocking::Client;
use serde_json::Value;
use tiny_http::{Header, Response, Server, StatusCode};

const LISTEN_ADDR: &str = "127.0.0.1:47865";

const UPSTREAM_LATEST_JSON: &str =
    "https://github.com/waxilo/CodeCliManager/releases/latest/download/latest.json";

fn manifest_candidates() -> [&'static str; 1] {
    [UPSTREAM_LATEST_JSON]
}

/// 按优先级排列的镜像前缀（完整 URL = 前缀 + 原始 GitHub URL）。
const MIRROR_PREFIXES: &[&str] = &[
    "https://ghfast.top/",
    "https://gh-proxy.com/",
    "https://mirror.ghproxy.com/",
];

/// 探测后缓存的首个可用镜像；`None` 表示全部不可达（保持直连）。
static WORKING_MIRROR: OnceLock<Option<&'static str>> = OnceLock::new();

static STARTED: OnceLock<bool> = OnceLock::new();

/// 启动本地清单代理（幂等）。失败只打日志，不阻断应用启动。
pub fn start_updater_manifest_proxy() {
    if STARTED.set(true).is_err() {
        return;
    }

    thread::spawn(|| {
        let server = match Server::http(LISTEN_ADDR) {
            Ok(server) => server,
            Err(e) => {
                eprintln!("[updater-manifest] bind {LISTEN_ADDR} failed: {e}");
                return;
            }
        };
        eprintln!("[updater-manifest] listening on http://{LISTEN_ADDR}");

        let client = match Client::builder()
            .timeout(Duration::from_secs(12))
            .redirect(reqwest::redirect::Policy::limited(8))
            .build()
        {
            Ok(client) => client,
            Err(e) => {
                eprintln!("[updater-manifest] http client failed: {e}");
                return;
            }
        };

        for request in server.incoming_requests() {
            let path = request.url().split('?').next().unwrap_or("/");

            // Host 校验：仅接受本机回环地址，阻断 DNS rebinding
            let host_ok = request
                .headers()
                .iter()
                .find(|header| header.field.equiv("host"))
                .map(|header| is_loopback_host(header.value.as_str()))
                .unwrap_or(false);
            if !host_ok {
                let body = r#"{"error":"invalid host"}"#;
                let response = Response::from_string(body)
                    .with_status_code(StatusCode(400))
                    .with_header(json_header())
                    .with_header(Header::from_bytes("Connection", "close").expect("valid header"));
                let _ = request.respond(response);
                continue;
            }

            if request.method() == &tiny_http::Method::Options {
                let mut response = Response::from_string("")
                    .with_status_code(StatusCode(204))
                    .with_header(Header::from_bytes("Access-Control-Allow-Methods", "GET,OPTIONS").expect("valid header"))
                    .with_header(Header::from_bytes("Access-Control-Allow-Headers", "content-type").expect("valid header"));
                for header in cors_headers_for(&request) {
                    response = response.with_header(header);
                }
                let _ = request.respond(response);
                continue;
            }

            if path != "/latest.json" && path != "/" {
                let body = r#"{"error":"not found"}"#;
                let mut response = Response::from_string(body)
                    .with_status_code(StatusCode(404))
                    .with_header(json_header());
                for header in cors_headers_for(&request) {
                    response = response.with_header(header);
                }
                let _ = request.respond(response);
                continue;
            }

            match fetch_and_rewrite_manifest(&client) {
                Ok(json) => {
                    let mut response = Response::from_string(json)
                        .with_status_code(StatusCode(200))
                        .with_header(json_header())
                        .with_header(
                            Header::from_bytes("Cache-Control", "no-store").expect("valid header"),
                        );
                    for header in cors_headers_for(&request) {
                        response = response.with_header(header);
                    }
                    let _ = request.respond(response);
                }
                Err(e) => {
                    eprintln!("[updater-manifest] fetch failed: {e}");
                    let body =
                        format!(r#"{{"error":{}}}"#, serde_json::to_string(&e).unwrap_or_else(|_| "\"error\"".into()));
                    let mut response = Response::from_string(body)
                        .with_status_code(StatusCode(502))
                        .with_header(json_header());
                    for header in cors_headers_for(&request) {
                        response = response.with_header(header);
                    }
                    let _ = request.respond(response);
                }
            }
        }
    });
}

fn json_header() -> Header {
    Header::from_bytes("Content-Type", "application/json; charset=utf-8").expect("valid header")
}

fn is_loopback_host(host: &str) -> bool {
    let host = host.trim();
    let bare = if let Some(rest) = host.strip_prefix('[') {
        rest.split(']').next().unwrap_or(rest).to_string()
    } else {
        host.split(':').next().unwrap_or(host).to_string()
    };
    matches!(
        bare.as_str(),
        "127.0.0.1" | "localhost" | "::1" | "0:0:0:0:0:0:0:1"
    )
}

fn request_origin(request: &tiny_http::Request) -> Option<&str> {
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv("origin"))
        .map(|header| header.value.as_str())
}

fn is_loopback_origin(origin: &str) -> bool {
    origin == "tauri://localhost"
        || origin == "http://tauri.localhost"
        || origin == "https://tauri.localhost"
        || origin.starts_with("http://localhost:")
        || origin.starts_with("https://localhost:")
        || origin.starts_with("http://127.0.0.1:")
        || origin.starts_with("https://127.0.0.1:")
        || origin.starts_with("http://[::1]:")
        || origin.starts_with("https://[::1]:")
}

/// 仅对本机来源回显 CORS 头；原生客户端（无 Origin）不返回任何 CORS 头。
fn cors_headers_for(request: &tiny_http::Request) -> Vec<Header> {
    let Some(origin) = request_origin(request) else {
        return Vec::new();
    };
    if !is_loopback_origin(origin) {
        return Vec::new();
    }
    vec![
        Header::from_bytes("Access-Control-Allow-Origin", origin).expect("valid header"),
        Header::from_bytes("Vary", "Origin").expect("valid header"),
    ]
}

fn fetch_and_rewrite_manifest(client: &Client) -> Result<String, String> {
    let response = client
        .get(manifest_candidates()[0])
        .send()
        .map_err(|e| format!("可信 GitHub 更新清单请求失败: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("可信 GitHub 更新清单返回 HTTP {status}"));
    }
    let text = response
        .text()
        .map_err(|e| format!("读取可信 GitHub 更新清单失败: {e}"))?;
    let mut value: Value =
        serde_json::from_str(&text).map_err(|e| format!("可信 latest.json 无效: {e}"))?;
    if let Some(mirror_prefix) = pick_mirror_prefix(client) {
        rewrite_platform_urls(&mut value, mirror_prefix);
    }
    // 所有镜像均不可用时保持直连 GitHub 地址，作为最后的兜底
    serde_json::to_string(&value).map_err(|e| e.to_string())
}

/// 按序探测并缓存首个可用的镜像前缀。
///
/// 只探测镜像的连通性（连接建立即视为可达，4xx/3xx 不影响下载），
/// 不探测镜像是否返回了正确内容——镜像故障时由 updater 侧走备用端点。
/// 结果用 `OnceLock` 缓存，整个进程生命周期内只探测一次。
fn pick_mirror_prefix(client: &Client) -> Option<&'static str> {
    if let Some(cached) = WORKING_MIRROR.get() {
        return *cached;
    }
    let picked = MIRROR_PREFIXES.iter().find(|prefix| {
        let probe_url = format!("{prefix}https://github.com/");
        client
            .get(&probe_url)
            .timeout(Duration::from_secs(5))
            .send()
            .is_ok()
    });
    let result = picked.copied();
    // 竞态下多个请求同时探测：OnceLock 保证只写入一次，未写入方直接丢弃
    let _ = WORKING_MIRROR.set(result);
    WORKING_MIRROR.get().copied().flatten()
}

fn rewrite_platform_urls(manifest: &mut Value, mirror_prefix: &str) {
    let Some(platforms) = manifest.get_mut("platforms").and_then(|v| v.as_object_mut()) else {
        return;
    };
    for platform in platforms.values_mut() {
        let Some(url) = platform.get("url").and_then(|v| v.as_str()).map(|s| s.to_string()) else {
            continue;
        };
        let rewritten = rewrite_github_url(&url, mirror_prefix);
        if let Some(obj) = platform.as_object_mut() {
            obj.insert("url".to_string(), Value::String(rewritten));
        }
    }
}

fn rewrite_github_url(url: &str, mirror_prefix: &str) -> String {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return trimmed.to_string();
    }
    // 已是镜像地址则不重复包裹
    if MIRROR_PREFIXES.iter().any(|prefix| trimmed.starts_with(prefix)) {
        return trimmed.to_string();
    }
    if trimmed.starts_with("https://github.com/")
        || trimmed.starts_with("https://objects.githubusercontent.com/")
        || trimmed.starts_with("https://release-assets.githubusercontent.com/")
    {
        return format!("{mirror_prefix}{trimmed}");
    }
    trimmed.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn manifest_candidates_only_include_trusted_direct_source() {
        assert_eq!(manifest_candidates(), [UPSTREAM_LATEST_JSON]);
        assert!(manifest_candidates()
            .iter()
            .all(|candidate| !MIRROR_PREFIXES.iter().any(|prefix| candidate.starts_with(prefix))));
    }

    #[test]
    fn rewrites_github_platform_urls() {
        let mut manifest = json!({
            "version": "0.1.50",
            "platforms": {
                "darwin-aarch64": {
                    "signature": "sig",
                    "url": "https://github.com/waxilo/CodeCliManager/releases/download/v0.1.50/a.tar.gz"
                }
            }
        });
        rewrite_platform_urls(&mut manifest, "https://ghfast.top/");
        assert_eq!(
            manifest["platforms"]["darwin-aarch64"]["url"],
            "https://ghfast.top/https://github.com/waxilo/CodeCliManager/releases/download/v0.1.50/a.tar.gz"
        );
    }

    #[test]
    fn does_not_double_wrap_mirrored_urls() {
        let already = "https://ghfast.top/https://github.com/waxilo/CodeCliManager/releases/download/v0.1.50/a.tar.gz";
        assert_eq!(rewrite_github_url(already, "https://ghfast.top/"), already);
    }

    #[test]
    fn loopback_hosts_are_accepted_but_foreign_hosts_rejected() {
        assert!(is_loopback_host("127.0.0.1:47865"));
        assert!(is_loopback_host("localhost:47865"));
        assert!(is_loopback_host("[::1]:47865"));
        assert!(!is_loopback_host("evil.example.com"));
        assert!(!is_loopback_host("evil.example.com:47865"));
        assert!(!is_loopback_host(""));
    }

    #[test]
    fn cors_headers_only_for_loopback_origins() {
        // 无 Origin（原生客户端）→ 不发 CORS 头
        // （is_loopback_origin 是核心判断，跨来源头由调用处按结果决定是否回显）
        assert!(is_loopback_origin("http://localhost:1420"));
        assert!(is_loopback_origin("http://127.0.0.1:5173"));
        assert!(is_loopback_origin("tauri://localhost"));
        assert!(is_loopback_origin("http://tauri.localhost"));
        assert!(!is_loopback_origin("https://evil.example.com"));
        assert!(!is_loopback_origin(""));
    }

    #[test]
    fn all_mirrors_down_keeps_direct_github_urls() {
        // 模拟 pick_mirror_prefix 返回 None（无可用镜像）时的兜底：
        // 传空前缀等同于不改写，保持直连 GitHub 地址
        let mut manifest = json!({
            "version": "0.1.50",
            "platforms": {
                "darwin-aarch64": {
                    "signature": "sig",
                    "url": "https://github.com/waxilo/CodeCliManager/releases/download/v0.1.50/a.tar.gz"
                }
            }
        });
        rewrite_platform_urls(&mut manifest, "");
        assert_eq!(
            manifest["platforms"]["darwin-aarch64"]["url"],
            "https://github.com/waxilo/CodeCliManager/releases/download/v0.1.50/a.tar.gz"
        );
    }
}
