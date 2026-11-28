//! Ports `server/controller/chats/carryover/outcome.ts`.

use garcon_contract::{
    transcript_notice_details::TranscriptNoticeDetail, transcript_seed::CarriedContext,
};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum CarryOverOutcome {
    NoHistory,
    Complete {
        context: CarriedContext,
    },
    Compacted {
        context: CarriedContext,
        summary: String,
    },
}

#[derive(Debug, PartialEq, Serialize)]
pub struct CarryOverNotice {
    pub title: &'static str,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<TranscriptNoticeDetail>,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct ResolvedCarryOverOutcome {
    pub context: Option<CarriedContext>,
    pub notice: Option<CarryOverNotice>,
}

pub fn resolve_carry_over_outcome(outcome: CarryOverOutcome) -> ResolvedCarryOverOutcome {
    match outcome {
        CarryOverOutcome::NoHistory => ResolvedCarryOverOutcome {
            context: None,
            notice: None,
        },
        CarryOverOutcome::Complete { context } => ResolvedCarryOverOutcome {
            context: Some(context),
            notice: Some(CarryOverNotice {
                title: "History carried without compaction",
                content: "Earlier chat history was small enough to carry over as context.".into(),
                detail: None,
            }),
        },
        CarryOverOutcome::Compacted { context, summary } => ResolvedCarryOverOutcome {
            context: Some(context),
            notice: Some(CarryOverNotice {
                title: "Handoff summary",
                content: summary,
                detail: Some(TranscriptNoticeDetail::HandoffSummary),
            }),
        },
    }
}
