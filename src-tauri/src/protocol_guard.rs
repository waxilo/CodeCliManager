const PROTOCOL_LEAK_MARKERS: [&str; 4] = [
    "assistant to=functions.",
    "assistant to=functions ",
    "assistant to=multi_tool_use.",
    "assistant to=multi_tool_use ",
];

/// Incrementally removes leaked internal tool-routing text from model output.
///
/// Markers are recognized only at the beginning of a line. A short candidate
/// suffix is retained so markers split across upstream chunks are still found.
pub(crate) struct ProtocolTextGuard {
    pending: String,
    pending_starts_at_line_boundary: bool,
    blocked: bool,
}

impl Default for ProtocolTextGuard {
    fn default() -> Self {
        Self {
            pending: String::new(),
            pending_starts_at_line_boundary: true,
            blocked: false,
        }
    }
}

impl ProtocolTextGuard {
    pub(crate) fn push(&mut self, text: &str) -> String {
        if self.blocked || text.is_empty() {
            return String::new();
        }
        self.pending.push_str(text);

        if let Some(index) = PROTOCOL_LEAK_MARKERS
            .iter()
            .filter_map(|marker| self.find_marker(marker))
            .min()
        {
            self.blocked = true;
            self.pending.truncate(index);
            return std::mem::take(&mut self.pending);
        }

        let retained = PROTOCOL_LEAK_MARKERS
            .iter()
            .map(|marker| self.candidate_suffix_len(marker))
            .max()
            .unwrap_or(0);
        let release_len = self.pending.len().saturating_sub(retained);
        let retained_text = self.pending.split_off(release_len);
        let released = std::mem::replace(&mut self.pending, retained_text);
        self.pending_starts_at_line_boundary = if self.pending.is_empty() {
            released.ends_with(['\n', '\r'])
        } else {
            true
        };
        released
    }

    pub(crate) fn finish(&mut self) -> String {
        if self.blocked {
            String::new()
        } else {
            let trailing = std::mem::take(&mut self.pending);
            self.pending_starts_at_line_boundary = true;
            trailing
        }
    }

    pub(crate) fn detected(&self) -> bool {
        self.blocked
    }

    pub(crate) fn reset(&mut self) {
        self.pending.clear();
        self.pending_starts_at_line_boundary = true;
        self.blocked = false;
    }

    fn find_marker(&self, marker: &str) -> Option<usize> {
        self.pending
            .match_indices(marker)
            .map(|(index, _)| index)
            .find(|index| self.is_line_boundary(*index))
    }

    fn candidate_suffix_len(&self, marker: &str) -> usize {
        (1..marker.len())
            .rev()
            .find(|length| {
                let prefix = &marker.as_bytes()[..*length];
                if !self.pending.as_bytes().ends_with(prefix) {
                    return false;
                }
                let index = self.pending.len() - length;
                self.is_line_boundary(index)
            })
            .unwrap_or(0)
    }

    fn is_line_boundary(&self, index: usize) -> bool {
        if index == 0 {
            return self.pending_starts_at_line_boundary;
        }
        matches!(self.pending.as_bytes().get(index - 1), Some(b'\n' | b'\r'))
    }
}

/// 一次性净化整段文本（非流式路径）。
pub(crate) fn sanitize_protocol_text(text: &str) -> (String, bool) {
    let mut guard = ProtocolTextGuard::default();
    let mut visible = guard.push(text);
    visible.push_str(&guard.finish());
    (visible, guard.detected())
}

/// 规范化最终 stop_reason，避免 Claude Code `[ede_diagnostic]`。
///
/// 规则：
/// - 真正发出了 tool_use 块 → `tool_use`
/// - 协议泄漏截断 → `max_tokens`
/// - 声称 `tool_use` 但没有工具块 → 降为 `end_turn`
/// - 保留真实的 `max_tokens`
pub(crate) fn normalize_stop_reason(
    claimed_stop_reason: &str,
    has_tool_blocks: bool,
    protocol_leak: bool,
) -> &'static str {
    if has_tool_blocks {
        return "tool_use";
    }
    if protocol_leak {
        return "max_tokens";
    }
    match claimed_stop_reason {
        "tool_use" => "end_turn",
        "max_tokens" => "max_tokens",
        _ => "end_turn",
    }
}

#[cfg(test)]
mod tests {
    use super::{normalize_stop_reason, sanitize_protocol_text, ProtocolTextGuard};

    #[test]
    fn blocks_function_route_split_across_chunks() {
        let mut guard = ProtocolTextGuard::default();
        let mut visible = guard.push("正常结论。\nassistant to=func");
        visible.push_str(&guard.push("tions.Bash (commentary)\nNo."));
        visible.push_str(&guard.finish());

        assert_eq!(visible, "正常结论。\n");
        assert!(guard.detected());
    }

    #[test]
    fn blocks_multi_tool_route() {
        let mut guard = ProtocolTextGuard::default();
        let mut visible = guard.push("正文\nassistant to=multi_tool_");
        visible.push_str(&guard.push("use.parallel (commentary)"));

        assert_eq!(visible, "正文\n");
        assert!(guard.detected());
    }

    #[test]
    fn preserves_inline_protocol_reference() {
        let mut guard = ProtocolTextGuard::default();
        let text = "可在文档中引用 `assistant to=functions.Bash` 作为示例。";
        let mut visible = guard.push(text);
        visible.push_str(&guard.finish());

        assert_eq!(visible, text);
        assert!(!guard.detected());
    }

    #[test]
    fn preserves_normal_text_across_chunks() {
        let mut guard = ProtocolTextGuard::default();
        let mut visible = guard.push("普通 assistant to=func");
        visible.push_str(&guard.push("tions 说明"));
        visible.push_str(&guard.finish());

        assert_eq!(visible, "普通 assistant to=functions 说明");
        assert!(!guard.detected());
    }

    #[test]
    fn sanitize_protocol_text_blocks_leak() {
        let (visible, detected) =
            sanitize_protocol_text("正常结论。\nassistant to=functions.Bash (commentary)\nNo.");

        assert_eq!(visible, "正常结论。\n");
        assert!(detected);
    }

    #[test]
    fn normalize_stop_reason_keeps_real_tool_use() {
        assert_eq!(
            normalize_stop_reason("end_turn", true, false),
            "tool_use"
        );
    }

    #[test]
    fn normalize_stop_reason_downgrades_claimed_tool_use() {
        assert_eq!(
            normalize_stop_reason("tool_use", false, false),
            "end_turn"
        );
    }

    #[test]
    fn normalize_stop_reason_prefers_max_tokens_on_protocol_leak() {
        assert_eq!(
            normalize_stop_reason("tool_use", false, true),
            "max_tokens"
        );
    }

    #[test]
    fn normalize_stop_reason_keeps_max_tokens() {
        assert_eq!(
            normalize_stop_reason("max_tokens", false, false),
            "max_tokens"
        );
    }
}
