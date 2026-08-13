use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

/// 会话累计 token / 成本用量（单进程内跨轮次累积，随 turn-complete 以增量事件下发前端）。
/// 历史基线由前端从会话 JSONL 聚合（Conversation.usage），进程内增量叠加其上。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionUsage {
    pub(crate) input_tokens: u64,
    pub(crate) output_tokens: u64,
    pub(crate) cache_read: u64,
    pub(crate) cache_creation: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) cost_usd: Option<f64>,
}

impl SessionUsage {
    pub(crate) fn is_empty(&self) -> bool {
        self.input_tokens == 0
            && self.output_tokens == 0
            && self.cache_read == 0
            && self.cache_creation == 0
            && self.cost_usd.is_none()
    }
}

/// 当前进程内累计用量（session_id → 累计）
static SESSION_USAGE: Mutex<Option<HashMap<String, SessionUsage>>> = Mutex::new(None);
/// 已下发到前端的用量（用于计算增量）
static LAST_EMITTED_USAGE: Mutex<Option<HashMap<String, SessionUsage>>> = Mutex::new(None);

fn with_registry<T>(
    store: &'static Mutex<Option<HashMap<String, SessionUsage>>>,
    f: impl FnOnce(&mut HashMap<String, SessionUsage>) -> T,
) -> T {
    let mut guard = store.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    f(map)
}

pub(crate) fn accumulate_session_usage(
    sid: &str,
    input_tokens: u64,
    output_tokens: u64,
    cache_read: u64,
    cache_creation: u64,
) {
    if input_tokens == 0 && output_tokens == 0 && cache_read == 0 && cache_creation == 0 {
        return;
    }
    with_registry(&SESSION_USAGE, |map| {
        let entry = map.entry(sid.to_string()).or_default();
        entry.input_tokens += input_tokens;
        entry.output_tokens += output_tokens;
        entry.cache_read += cache_read;
        entry.cache_creation += cache_creation;
    });
}

/// result 事件携带 total_cost_usd（单次模型调用成本），逐次累加。
pub(crate) fn add_session_cost(sid: &str, cost_usd: f64) {
    if cost_usd <= 0.0 {
        return;
    }
    with_registry(&SESSION_USAGE, |map| {
        let entry = map.entry(sid.to_string()).or_default();
        *entry.cost_usd.get_or_insert(0.0) += cost_usd;
    });
}

/// 计算自上次 emit 以来的增量，并记录本次为最新已下发值。
/// 返回各字段为增量；全部为 0/None 时返回 None。
pub(crate) fn take_session_usage_delta(sid: &str) -> Option<SessionUsage> {
    let current = with_registry(&SESSION_USAGE, |map| map.get(sid).cloned()).unwrap_or_default();
    if current.is_empty() {
        return None;
    }
    let last = with_registry(&LAST_EMITTED_USAGE, |map| map.get(sid).cloned()).unwrap_or_default();

    let mut delta = SessionUsage {
        input_tokens: current.input_tokens.saturating_sub(last.input_tokens),
        output_tokens: current.output_tokens.saturating_sub(last.output_tokens),
        cache_read: current.cache_read.saturating_sub(last.cache_read),
        cache_creation: current.cache_creation.saturating_sub(last.cache_creation),
        cost_usd: None,
    };
    match (current.cost_usd, last.cost_usd) {
        (Some(c), Some(l)) => delta.cost_usd = Some(c - l),
        (Some(c), None) => delta.cost_usd = Some(c),
        (None, _) => delta.cost_usd = None,
    }

    with_registry(&LAST_EMITTED_USAGE, |map| {
        map.insert(sid.to_string(), current);
    });

    if delta.is_empty() {
        return None;
    }
    Some(delta)
}

/// 将本轮累计用量增量推给前端（turn-complete / 进程结束时调用）。
pub(crate) fn emit_session_usage_if_any(app: &AppHandle, sid: &str) {
    let Some(delta) = take_session_usage_delta(sid) else {
        return;
    };
    let payload = serde_json::json!({
        "conversationId": sid,
        "inputTokens": delta.input_tokens,
        "outputTokens": delta.output_tokens,
        "cacheRead": delta.cache_read,
        "cacheCreation": delta.cache_creation,
        "costUsd": delta.cost_usd,
    });
    let _ = app.emit("session-usage-updated", &payload);
    eprintln!(
        "[usage] emit session-usage-updated: {} (in={} out={} cr={} cc={} cost={:?})",
        sid,
        delta.input_tokens,
        delta.output_tokens,
        delta.cache_read,
        delta.cache_creation,
        delta.cost_usd
    );
}
