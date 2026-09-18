//! Owner-visible retained conversation projections, independent of unread attention.

use super::{
    AttemptStatus, Originator, RequestKind, RequestPrompt,
    attention::{AttentionRecord, FinalState},
};

pub const HISTORY_LIMIT: u64 = 20;
pub const HISTORY_MAX_LIMIT: u64 = 50;
pub const HISTORY_PREVIEW_CHARS: usize = 160;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HistoryScope {
    Recipient {
        identity_id: String,
        room_id: Option<String>,
    },
    Room(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryCursor {
    pub prepared_at_ms: u64,
    pub request_id: String,
}

pub struct HistoryQuery {
    pub scope: HistoryScope,
    pub before: Option<HistoryCursor>,
    pub limit: u64,
}

/// Storage metadata only; never loads response bodies for a history list.
pub struct HistoryRecord {
    pub attention: AttentionRecord,
    pub preview: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryItem<T = ()> {
    pub request_id: String,
    pub room_id: Option<String>,
    pub recipient_identity_id: Option<String>,
    pub originator: Originator,
    pub kind: RequestKind,
    pub prepared_at_ms: u64,
    pub delivery: AttemptStatus,
    /// Inbox acknowledgment only. Pane transport cannot prove agent read state.
    pub recipient_acknowledged: Option<bool>,
    pub final_state: FinalState<T>,
}

pub struct HistorySummary {
    pub item: HistoryItem,
    pub preview: Option<String>,
}

pub struct HistoryPage {
    pub items: Vec<HistorySummary>,
    pub next_before: Option<HistoryCursor>,
}

pub struct HistoryDetail {
    pub item: HistoryItem<String>,
    pub prompt: RequestPrompt,
}
