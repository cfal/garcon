//! Ports `server/controller/routes/combined-messages.ts`.

use std::{error::Error, rc::Rc};

use garcon_base::{
    http_body::{JsonBodyError, parse_json_body},
    http_error::json_error,
};
use garcon_chats::{
    chat_message_reader::{ResendCandidates, TranscriptAnchorPageReader},
    chat_processing_activity::ChatProcessingActivity,
    store::ChatRegistry,
};
use garcon_contract::{
    chat_view::{ChatHistoryState, ResendCandidate},
    transcript_anchor_page::{TranscriptAnchorDirection, parse_transcript_anchor_request},
};
use garcon_ledger::{errors::LedgerError, view_reader::TranscriptAnchorRead};
use http::{Method, StatusCode};
use serde::Serialize;

use crate::{
    compose_routes::RouteMap,
    http_route::response,
    http_route_types::{Route, RouteResult},
    json_route::json_response,
    listener::HttpRequest,
};

use super::transcript_history_error::{stale_transcript_view, transcript_history_error};

pub struct CombinedMessageRoutes {
    pub registry: Rc<ChatRegistry>,
    pub reader: Rc<dyn TranscriptAnchorPageReader>,
    pub processing: Rc<ChatProcessingActivity>,
    pub resend_candidates: Rc<ResendCandidates>,
}

pub fn create_combined_message_routes(deps: &Rc<CombinedMessageRoutes>) -> RouteMap<Route> {
    let deps = Rc::clone(deps);
    let post = Route::new(Default::default(), move |request, _, _| {
        let deps = Rc::clone(&deps);
        async move { combined_messages(&deps, request).await }
    });
    RouteMap::from([(
        "/api/v1/chats/combined-messages".into(),
        [(Method::POST, post)].into(),
    )])
}

async fn combined_messages(deps: &CombinedMessageRoutes, request: HttpRequest) -> RouteResult {
    let signal = request.body().cancellation().clone();
    let body = match parse_json_body(request).await {
        Ok(body) => body,
        Err(JsonBodyError::Malformed(error)) => return Err(error.into()),
        Err(JsonBodyError::Read(error)) => return Err(error as Box<dyn Error>),
    };
    let input = match parse_transcript_anchor_request(&body) {
        Ok(input) => input,
        Err(error) => {
            return Ok(json_error(
                error.to_string(),
                400.0,
                Some("VALIDATION_FAILED"),
                Some(false),
                None,
            )?
            .map(Some));
        }
    };
    let chat_id = &input.chat_id;
    let missing = || {
        Ok(json_error(
            "Session not found",
            404.0,
            Some("SESSION_NOT_FOUND"),
            None,
            None,
        )?
        .map(Some))
    };
    if !deps.registry.has_chat(chat_id) {
        return missing();
    }

    let work = async {
        let page = deps.reader.anchor_page(&input, &signal).await?;
        if signal.is_cancelled() {
            return Ok(response(StatusCode::from_u16(499)?, None));
        }
        if !deps.registry.has_chat(chat_id) {
            return missing();
        }
        if input
            .transcript_view_id
            .as_deref()
            .is_some_and(|view| view != page.transcript_view_id.as_str())
        {
            return stale_transcript_view();
        }
        let resend_candidates = if input.direction == TranscriptAnchorDirection::Backward
            && input.cursor_ordinal.is_none()
            && deps.processing.phase(chat_id).is_none()
        {
            (deps.resend_candidates)(chat_id)?
        } else {
            vec![]
        };
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct CombinedHistoryReply<'a> {
            #[serde(flatten)]
            page: TranscriptAnchorRead,
            history_state: ChatHistoryState,
            chat_id: &'a str,
            resend_candidates: Vec<ResendCandidate>,
        }
        Ok(json_response(
            StatusCode::OK,
            &CombinedHistoryReply {
                page,
                history_state: ChatHistoryState::Complete,
                chat_id,
                resend_candidates,
            },
        )?)
    };
    let error = match work.await {
        Ok(reply) => return Ok(reply),
        Err(error) => error,
    };
    if signal.is_cancelled() {
        return transcript_history_error(error.as_ref(), chat_id, &signal);
    }
    if !deps.registry.has_chat(chat_id) {
        return missing();
    }
    if matches!(
        error.downcast_ref::<LedgerError>(),
        Some(LedgerError::BulkOperationAbandoned { .. })
    ) {
        return Ok(json_error(
            "Transcript read interrupted; retry.",
            503.0,
            Some("TRANSCRIPT_READ_INTERRUPTED"),
            Some(true),
            None,
        )?
        .map(Some));
    }
    transcript_history_error(error.as_ref(), chat_id, &signal)
}
