//! Ports `server/controller/routes/transcript-history-error.ts`.

use std::error::Error;

use garcon_base::{
    domain_error::as_domain_error,
    errors::ErrorInput,
    http_error::{json_error, json_error_from_unknown},
    log::{Logger, create_logger},
};
use garcon_contract::{
    chat_view::{ChatHistoryState, UnavailableChatHistoryResponse},
    error_codes::ErrorCode,
};
use garcon_ledger::{
    errors::{LedgerError, safe_fence_diagnostic},
    view_reader::TranscriptHistoryUnavailableError,
};
use http::StatusCode;
use tokio_util::sync::CancellationToken;

use crate::{http_route::response, http_route_types::RouteResult, json_route::json_response};

pub(super) fn stale_transcript_view() -> RouteResult {
    Ok(json_error(
        "Transcript view changed while paging",
        409.0,
        Some("STALE_TRANSCRIPT_VIEW"),
        Some(false),
        None,
    )?
    .map(Some))
}

pub(super) fn transcript_history_error(
    error: &(dyn Error + 'static),
    chat_id: &str,
    signal: &CancellationToken,
) -> RouteResult {
    if signal.is_cancelled() {
        return Ok(response(StatusCode::from_u16(499)?, None));
    }
    let logger = create_logger("routes:chats");
    let unavailable = error.downcast_ref::<TranscriptHistoryUnavailableError>();
    if let Some(unavailable) = unavailable
        && matches!(
            &unavailable.history_state,
            ChatHistoryState::Degraded { error_code, .. } if error_code == "LEDGER_FENCED"
        )
    {
        if let Some(cause) = unavailable.source() {
            logger.warn(&format!(
                "Transcript ledger read is fenced. {:?}",
                safe_fence_diagnostic(cause)
            ));
        } else {
            logger.warn("Transcript ledger read is fenced.");
        }
        return history_unavailable(chat_id, unavailable.history_state.clone());
    }
    logger.error(&format!(
        "sessions: error reading messages for {chat_id}: {error}"
    ));
    if matches!(
        error.downcast_ref::<LedgerError>(),
        Some(LedgerError::StaleView { .. })
    ) {
        return stale_transcript_view();
    }
    if as_domain_error(error)
        .is_some_and(|error| error.code == ErrorCode::CARRYOVER_HISTORY_UNAVAILABLE)
    {
        return history_unavailable(
            chat_id,
            ChatHistoryState::Degraded {
                error_code: "CARRYOVER_HISTORY_UNAVAILABLE".into(),
                retryable: false,
            },
        );
    }
    if let Some(unavailable) = unavailable {
        return history_unavailable(chat_id, unavailable.history_state.clone());
    }
    Ok(json_error_from_unknown(ErrorInput::Error(error), None, None, None)?.map(Some))
}

fn history_unavailable(chat_id: &str, history_state: ChatHistoryState) -> RouteResult {
    Ok(json_response(
        StatusCode::OK,
        &UnavailableChatHistoryResponse {
            history_state,
            chat_id: chat_id.to_owned(),
            messages: [],
        },
    )?)
}
