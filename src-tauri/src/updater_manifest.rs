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
            if request.method() == &tiny_http::Method::Options {
                let response = Response::from_string("")
                    .with_status_code(StatusCode(204))
                    .with_header(cors_header());
                let _ = request.respond(response);
                continue;
            }

            if path != "/latest.json" && path != "/" {
                let body = r#"{"error":"not found"}"#;
                let response = Response::from_string(body)
                    .with_status_code(StatusCode(404))
                    .with_header(json_header())
                    .with_header(cors_header());
                let _ = request.respond(response);
                continue;
            }

            match fetch_and_rewrite_manifest(&client) {
                Ok(json) => {
                    let response = Response::from_string(json)
                        .with_status_code(StatusCode(200))
                        .with_header(json_header())
                        .with_header(cors_header())
                        .with_header(
                            Header::from_bytes("Cache-Control", "no-store").expect("valid header"),
                        );
                    let _ = request.respond(response);
                }
                Err(e) => {
                    eprintln!("[updater-manifest] fetch failed: {e}");
                    let body =
                        format!(r#"{{"error":{}}}"#, serde_json::to_string(&e).unwrap_or_else(|_| "\"error\"".into()));
                    let response = Response::from_string(body)
                        .with_status_code(StatusCode(502))
                        .with_header(json_header())
                        .with_header(cors_header());
                    let _ = request.respond(response);
                }
            }
        }
    });
}

fn json_header() -> Header {
    Header::from_bytes("Content-Type", "application/json; charset=utf-8").expect("valid header")
}

fn cors_header() -> Header {
    Header::from_bytes("Access-Control-Allow-Origin", "*").expect("valid header")
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
    rewrite_platform_urls(&mut value, MIRROR_PREFIXES[0]);
    serde_json::to_string(&value).map_err(|e| e.to_string())
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
}
