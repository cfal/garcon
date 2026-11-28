use garcon_base::errors::{DiagnosticError, error_metadata};
use garcon_cases::{CaseError, replay, unknown};
use garcon_contract::{
    chat_id::ChatId, garcon_command_rejection::GarconCommandIssue,
    garcon_commands::GarconEdgeCommand,
};
use garcon_interface::producer::AgentProducedRow;
use garcon_js::{Number, json::from_slice};
use garcon_ledger::{
    codec::{EncodedLedgerDraft, StoredLedgerRow, decode_ledger_row, encode_ledger_draft},
    contracts::{TranscriptViewId, transcript_view_id},
    garcon_command_publication::{
        AgentCommandSource, GarconCommandDispatch, PendingGarconCommand,
        PendingGarconCommandRejection, canonicalize_garcon_producer_rows, dispatch_garcon_commands,
    },
};
use serde::Serialize;
use serde_json::Value;

const VIEW: &str = "producer-fixture";
const CHAT: &str = "synthetic-chat";
const RUN: &str = "synthetic-run";

#[derive(Serialize)]
struct Draft<'a> {
    kind: &'static str,
    at: &'a str,
    #[serde(flatten)]
    encoded: EncodedLedgerDraft,
}

#[derive(Serialize)]
struct CanonicalRows<'a> {
    drafts: Vec<Draft<'a>>,
    commands: &'a [PendingGarconCommand],
    rejections: &'a [PendingGarconCommandRejection],
}

#[derive(Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
enum Event<'a> {
    Request {
        source: AgentCommandSource<'a>,
        command: &'a GarconEdgeCommand,
    },
    ChatId {
        chat_id: &'a str,
        view_id: &'a TranscriptViewId,
        run_id: Option<&'a str>,
        at: &'a str,
    },
    InterAgent {
        source_chat_id: &'a str,
        source_view_id: &'a TranscriptViewId,
        request_at: &'a str,
        recipients: &'a [ChatId],
        hide_sender: bool,
        body: &'a str,
    },
    Rejected {
        chat_id: &'a str,
        view_id: &'a TranscriptViewId,
        notice_ordinal: u64,
        issues: &'a [GarconCommandIssue],
    },
}

impl<'a> From<GarconCommandDispatch<'a>> for Event<'a> {
    fn from(event: GarconCommandDispatch<'a>) -> Self {
        match event {
            GarconCommandDispatch::Request { source, command } => Self::Request { source, command },
            GarconCommandDispatch::ChatIdRequest {
                chat_id,
                view_id,
                run_id,
                at,
            } => Self::ChatId {
                chat_id,
                view_id,
                run_id,
                at,
            },
            GarconCommandDispatch::InterAgentMessage {
                source_chat_id,
                source_view_id,
                request_at,
                recipients,
                hide_sender,
                body,
            } => Self::InterAgent {
                source_chat_id,
                source_view_id,
                request_at,
                recipients,
                hide_sender,
                body,
            },
            GarconCommandDispatch::Rejected {
                chat_id,
                view_id,
                notice_ordinal,
                issues,
            } => Self::Rejected {
                chat_id,
                view_id,
                notice_ordinal,
                issues,
            },
        }
    }
}

fn write(value: impl Serialize) -> Result<Value, CaseError> {
    let bytes =
        serde_json::to_vec(&value).map_err(|error| CaseError::undeliverable(error.to_string()))?;
    from_slice(&bytes).map_err(|error| CaseError::undeliverable(error.to_string()))
}

fn dispatch(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    let rows: Vec<AgentProducedRow> =
        serde_json::from_value(unknown(function, args.first())?.into_owned())
            .map_err(|error| CaseError::undeliverable(error.to_string()))?;
    let publication = canonicalize_garcon_producer_rows(rows)
        .map_err(|error| CaseError::new(error_metadata(error.as_ref()).name, error.to_string()))?;
    let drafts = publication
        .drafts
        .iter()
        .map(|draft| {
            let encoded = encode_ledger_draft(draft).map_err(|error| {
                CaseError::new(error.diagnostic_metadata().name, error.to_string())
            })?;
            Ok(Draft {
                kind: draft.data.kind(),
                at: &draft.at,
                encoded,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    match function {
        "canonicalizeRowsFixture" => write(CanonicalRows {
            drafts,
            commands: &publication.commands,
            rejections: &publication.rejections,
        }),
        "dispatchRowsFixture" => {
            let omit_evidence = unknown(function, args.get(1))?.as_bool().ok_or_else(|| {
                CaseError::undeliverable("fixture error: omitEvidence must be a boolean")
            })?;
            let view = transcript_view_id(VIEW).unwrap();
            let mut committed = Vec::new();
            if !omit_evidence {
                for (index, draft) in drafts.into_iter().enumerate() {
                    committed.push(
                        decode_ledger_row(&StoredLedgerRow {
                            view_id: VIEW.into(),
                            ordinal: Number((11 + index) as f64),
                            kind: draft.kind.into(),
                            at: draft.at.into(),
                            client_message_id: draft.encoded.client_message_id,
                            payload_json: draft.encoded.payload_json,
                        })
                        .map_err(|error| {
                            CaseError::new(error.diagnostic_metadata().name, error.to_string())
                        })?,
                    );
                }
            }
            let mut events = Vec::new();
            dispatch_garcon_commands(&publication, CHAT, &view, Some(RUN), &committed, |event| {
                events.push(Event::from(event));
                Ok(())
            })
            .map_err(|error| {
                CaseError::new(error_metadata(error.as_ref()).name, error.to_string())
            })?;
            write(events)
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn producer_publication_matches_committed_command_evidence_and_dispatch() {
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/producer-publication"
        ),
        dispatch,
    );
    assert_eq!(stats.passed, stats.total);
}
