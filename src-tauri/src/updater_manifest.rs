//! 本地更新清单代理：解决国内直连 GitHub Releases 超时。
//!
//! 流程：
//! 1. 应用启动后在 `127.0.0.1:47865` 提供 `/latest.json`
//! 2. 优先直连可信 GitHub 拉取官方 `latest.json`；直连不可达时回退到镜像拉取
//! 3. 每次请求并行探测镜像，把清单里的 `platforms.*.url` 改写为最快可用镜像
//! 4. tauri-plugin-updater 请求本机清单，资产下载使用镜像 URL
//!
//! 安全说明：更新包（含签名）仍由 tauri-plugin-updater 用内置 pubkey 做 minisign
//! 校验；镜像即使篡改清单也只能让下载失败，无法注入任意代码。

use std::io::Read as _;
use std::sync::mpsc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};

use reqwest::blocking::Client;
use serde_json::Value;
use tiny_http::{Header, Response, Server, StatusCode};

const LISTEN_ADDR: &str = "127.0.0.1:47865";

const UPSTREAM_LATEST_JSON: &str =
    "https://github.com/waxilo/CodeCliManager/releases/latest/download/latest.json";

/// 直连 GitHub 拉取清单的超时；宁可快速失败，把时间留给镜像兜底。
const DIRECT_FETCH_TIMEOUT: Duration = Duration::from_secs(8);
/// 单个镜像拉取清单/探测的超时。
const MIRROR_FETCH_TIMEOUT: Duration = Duration::from_secs(6);
/// 等待任一镜像返回清单的最长时间。
const MANIFEST_FALLBACK_WAIT: Duration = Duration::from_secs(10);
/// 等待任一镜像探测结果的最长时间。
const PROBE_WAIT: Duration = Duration::from_secs(10);
/// 清单文本缓存时长：版本元数据短期不变，避免每次检查都重打 GitHub。
/// 镜像探测不缓存——下载停滞重试时会重新探测，换到可用镜像。
const MANIFEST_CACHE_TTL: Duration = Duration::from_secs(300);

/// 直连候选仅包含可信 GitHub 源（镜像只做 URL 改写与清单兜底）。
#[cfg(test)]
fn manifest_candidates() -> [&'static str; 1] {
    [UPSTREAM_LATEST_JSON]
}

/// 按优先级排列的镜像前缀（完整 URL = 前缀 + 原始 GitHub URL）。
const MIRROR_PREFIXES: &[&str] = &[
    "https://ghfast.top/",
    "https://gh-proxy.com/",
    "https://mirror.ghproxy.com/",
];

struct CachedManifest {
    text: String,
    fetched_at: Instant,
}

static MANIFEST_CACHE: OnceLock<Mutex<Option<CachedManifest>>> = OnceLock::new();

fn cached_manifest_text() -> Option<String> {
    let cache = MANIFEST_CACHE.get_or_init(|| Mutex::new(None));
    let guard = cache.lock().ok()?;
    let cached = guard.as_ref()?;
    if cached.fetched_at.elapsed() < MANIFEST_CACHE_TTL {
        Some(cached.text.clone())
    } else {
        None
    }
}

fn store_manifest_text(text: String) {
    if let Ok(mut guard) = MANIFEST_CACHE.get_or_init(|| Mutex::new(None)).lock() {
        *guard = Some(CachedManifest {
            text,
            fetched_at: Instant::now(),
        });
    }
}

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
            .timeout(Duration::from_secs(15))
            .connect_timeout(Duration::from_secs(5))
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
    // 清单文本短 TTL 缓存：版本元数据不会频繁变化，避免每次检查都直连 GitHub。
    let text = match cached_manifest_text() {
        Some(text) => text,
        None => {
            let text = fetch_manifest_text(client)?;
            store_manifest_text(text.clone());
            text
        }
    };
    let mut value: Value =
        serde_json::from_str(&text).map_err(|e| format!("可信 latest.json 无效: {e}"))?;
    if let Some(mirror_prefix) = pick_mirror_prefix(client) {
        rewrite_platform_urls(&mut value, mirror_prefix);
    }
    // 所有镜像均不可用时保持直连 GitHub 地址，作为最后的兜底
    serde_json::to_string(&value).map_err(|e| e.to_string())
}

/// 镜像上的清单地址（完整 URL = 镜像前缀 + 原始 GitHub URL）。
fn mirror_manifest_urls() -> Vec<String> {
    MIRROR_PREFIXES
        .iter()
        .map(|prefix| format!("{prefix}{UPSTREAM_LATEST_JSON}"))
        .collect()
}

/// 拉取官方清单：直连 GitHub 优先；直连超时/失败时并行尝试各镜像，首个成功者胜出。
fn fetch_manifest_text(client: &Client) -> Result<String, String> {
    // 直连（8s 快速失败，避免国内慢网干等）
    match fetch_url(client, UPSTREAM_LATEST_JSON, DIRECT_FETCH_TIMEOUT) {
        Ok(text) => return Ok(text),
        Err(direct_err) => eprintln!("[updater-manifest] 直连 GitHub 清单失败，回退镜像: {direct_err}"),
    }

    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    for url in mirror_manifest_urls() {
        let client = client.clone();
        let tx = tx.clone();
        // 不 join：线程带自身超时（MIRROR_FETCH_TIMEOUT），收到首个成功即返回，
        // 其余线程自灭，避免慢镜像拖慢本次请求。
        thread::spawn(move || {
            let result = fetch_url(&client, &url, MIRROR_FETCH_TIMEOUT);
            let _ = tx.send(result);
        });
    }
    drop(tx);
    // 最先成功的镜像即为可用镜像；超时后取最后错误（所有镜像均失败）
    let mut last_err: Option<String> = None;
    let deadline = Instant::now() + MANIFEST_FALLBACK_WAIT;
    for _ in 0..MIRROR_PREFIXES.len() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(remaining) {
            Ok(Ok(text)) => return Ok(text),
            Ok(Err(e)) => last_err = Some(e),
            Err(_) => break,
        }
    }
    Err(last_err.unwrap_or_else(|| "等待镜像清单超时".to_string()))
}

fn fetch_url(client: &Client, url: &str, timeout: Duration) -> Result<String, String> {
    let response = client
        .get(url)
        .timeout(timeout)
        .send()
        .map_err(|e| format!("请求 {url} 失败: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("{url} 返回 HTTP {status}"));
    }
    response.text().map_err(|e| format!("读取 {url} 响应失败: {e}"))
}

/// 并行探测所有镜像，返回第一个能真实传输内容的镜像前缀。
///
/// 每次 manifest 请求都重新探测（不缓存），保证前端下载停滞重试时能换镜像；
/// 全部失败返回 `None`，调用方保持直连 GitHub 作为兜底。
fn pick_mirror_prefix(client: &Client) -> Option<&'static str> {
    if MIRROR_PREFIXES.is_empty() {
        return None;
    }
    let (tx, rx) = mpsc::channel::<&'static str>();
    for prefix in MIRROR_PREFIXES.iter().copied() {
        let client = client.clone();
        let tx = tx.clone();
        // 不 join：线程带自身超时（MIRROR_FETCH_TIMEOUT），收到首个成功即返回，
        // 其余线程自灭，避免慢镜像拖慢每次请求。
        thread::spawn(move || {
            if probe_mirror(&client, prefix) {
                let _ = tx.send(prefix);
            }
        });
    }
    drop(tx);
    // 最先成功返回的镜像即为最快的可用镜像
    rx.recv_timeout(PROBE_WAIT).ok()
}

/// 真实内容传输探测：对镜像根路径发 `Range` 请求，必须实际读到 ≥1KB 才算可用。
/// 仅 TCP 连通（如 gh-proxy.com 曾出现）但传输停滞的镜像会被淘汰。
/// 探测目标用真实清单路径（RANGE 小范围），比首页更能代表资产下载可达性。
fn probe_mirror(client: &Client, prefix: &str) -> bool {
    let probe_url = format!("{prefix}{UPSTREAM_LATEST_JSON}");
    let Ok(resp) = client
        .get(&probe_url)
        .header(reqwest::header::RANGE, "bytes=0-2048")
        .timeout(MIRROR_FETCH_TIMEOUT)
        .send()
    else {
        return false;
    };
    let mut buf = Vec::with_capacity(2048);
    match resp.take(2048).read_to_end(&mut buf) {
        Ok(n) => n >= 1024,
        Err(_) => false,
    }
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

    #[test]
    fn mirror_manifest_urls_wrap_upstream_with_each_mirror() {
        let urls = mirror_manifest_urls();
        assert_eq!(urls.len(), MIRROR_PREFIXES.len());
        for url in &urls {
            assert!(
                MIRROR_PREFIXES
                    .iter()
                    .any(|prefix| url.starts_with(prefix)),
                "{url} 应带镜像前缀"
            );
            assert!(url.ends_with(UPSTREAM_LATEST_JSON));
        }
    }

    #[test]
    fn manifest_cache_roundtrip_within_ttl() {
        // 缓存写入后、TTL 内读取应返回同一文本
        store_manifest_text("cached-json".to_string());
        assert_eq!(cached_manifest_text().as_deref(), Some("cached-json"));
        // 清理，避免污染其他测试
        if let Ok(mut guard) = MANIFEST_CACHE.get_or_init(|| Mutex::new(None)).lock() {
            *guard = None;
        }
    }
}
