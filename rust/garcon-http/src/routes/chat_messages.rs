//! Raw transcript history from `server/controller/routes/chats.ts`.

use std::rc::Rc;

use garcon_base::{
    domain_error::DomainError, errors::ErrorInput, http_error::json_error_from_unknown,
};
use garcon_chats::{
    chat_message_reader::{ResendCandidates, TranscriptPageReader},
    chat_processing_activity::ChatProcessingActivity,
    store::ChatRegistry,
};
use garcon_contract::{
    chat_view::{
        CHAT_MESSAGES_MAX_LIMIT, ChatHistoryState, ResendCandidate, TranscriptPage,
        TranscriptReadPurpose,
    },
    error_codes::ErrorCode,
};
use garcon_js::{is_safe_integer, trim};
use http::{Method, StatusCode};
use serde::Serialize;
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::{
    compose_routes::RouteMap,
    http_route_types::{Route, RouteResult},
    json_route::json_response,
};

use super::transcript_history_error::{stale_transcript_view, transcript_history_error};

const DEFAULT_MESSAGES_LIMIT: u64 = 20;

pub struct ChatMessagesRoutes {
    pub registry: Rc<ChatRegistry>,
    pub pages: Rc<dyn TranscriptPageReader>,
    pub processing: Rc<ChatProcessingActivity>,
    pub resend_candidates: Rc<ResendCandidates>,
}

pub fn create_chat_messages_routes(deps: &Rc<ChatMessagesRoutes>) -> RouteMap<Route> {
    let deps = Rc::clone(deps);
    let get = Route::new(Default::default(), move |request, url, _| {
        let deps = Rc::clone(&deps);
        async move { get_messages(&deps, &url, request.body().cancellation()).await }
    });
    RouteMap::from([("/api/v1/chats/messages".into(), [(Method::GET, get)].into())])
}

async fn get_messages(
    deps: &ChatMessagesRoutes,
    url: &Url,
    signal: &CancellationToken,
) -> RouteResult {
    let Some(chat_id) = url
        .query_pairs()
        .find_map(|(key, id)| (key == "chatId").then_some(id))
        .filter(|id| !id.is_empty())
    else {
        return invalid(DomainError::new_validation(
            "chatId query parameter is required",
        ));
    };
    if !deps.registry.has_chat(&chat_id) {
        return invalid(DomainError::new(
            ErrorCode::SESSION_NOT_FOUND,
            "Session not found",
            404,
            false,
        ));
    }
    let args = match raw_messages_query(url) {
        Ok(args) => args,
        Err(error) => return invalid(error),
    };
    let work = async {
        let page = deps
            .pages
            .page(
                &chat_id,
                args.limit,
                args.before_ordinal,
                args.expected_view_id.as_deref(),
                signal,
                args.purpose,
            )
            .await?;
        if args
            .expected_view_id
            .as_deref()
            .is_some_and(|expected| expected != page.transcript_view_id)
        {
            return stale_transcript_view();
        }
        let resend_candidates = if deps.processing.phase(&chat_id).is_none() {
            (deps.resend_candidates)(&chat_id)?
        } else {
            vec![]
        };
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct RawHistoryReply<'a> {
            history_state: ChatHistoryState,
            chat_id: &'a str,
            #[serde(flatten)]
            page: TranscriptPage,
            resend_candidates: Vec<ResendCandidate>,
            limit: u64,
        }
        Ok(json_response(
            StatusCode::OK,
            &RawHistoryReply {
                history_state: ChatHistoryState::Complete,
                chat_id: &chat_id,
                page,
                resend_candidates,
                limit: args.limit,
            },
        )?)
    };
    match work.await {
        Ok(reply) => Ok(reply),
        Err(error) => transcript_history_error(error.as_ref(), &chat_id, signal),
    }
}

fn invalid(error: DomainError) -> RouteResult {
    Ok(json_error_from_unknown(ErrorInput::Error(&error), None, None, None)?.map(Some))
}

#[derive(Debug, PartialEq, Eq)]
struct RawMessagesQuery {
    limit: u64,
    before_ordinal: Option<u64>,
    expected_view_id: Option<String>,
    purpose: Option<TranscriptReadPurpose>,
}

fn raw_messages_query(url: &Url) -> Result<RawMessagesQuery, DomainError> {
    let query_value = |name| {
        url.query_pairs()
            .find_map(|(key, value)| (key == name).then_some(value))
    };
    let positive_integer = |name, message| {
        query_value(name)
            .as_deref()
            .map(trim)
            .filter(|raw| !raw.is_empty())
            .map(|raw| {
                positive_query_integer(raw).ok_or_else(|| DomainError::new_validation(message))
            })
            .transpose()
    };
    let limit = positive_integer("limit", "limit must be a positive integer")?
        .unwrap_or(DEFAULT_MESSAGES_LIMIT)
        .min(CHAT_MESSAGES_MAX_LIMIT);
    let before_ordinal =
        positive_integer("beforeOrdinal", "beforeOrdinal must be a positive integer")?;
    let purpose = match query_value("purpose").as_deref() {
        None => None,
        Some("activation") => Some(TranscriptReadPurpose::Activation),
        Some(_) => return Err(DomainError::new_validation("purpose must be activation")),
    };
    let expected_view_id = query_value("transcriptViewId")
        .as_deref()
        .map(trim)
        .filter(|id| !id.is_empty())
        .map(str::to_owned);
    if before_ordinal.is_some() {
        if expected_view_id.is_none() {
            return Err(DomainError::new_validation(
                "transcriptViewId query parameter is required for earlier pages",
            ));
        }
        if purpose.is_some() {
            return Err(DomainError::new_validation(
                "activation purpose is valid only for newest history",
            ));
        }
    }
    Ok(RawMessagesQuery {
        limit,
        before_ordinal,
        expected_view_id,
        purpose,
    })
}

// The raw-history route uses Number(text), unlike snapshot's decimal-only limit.
fn positive_query_integer(raw: &str) -> Option<u64> {
    let number = match raw.as_bytes() {
        [b'0', b'x' | b'X', ..] => prefixed_integer(&raw[2..], 16)?,
        [b'0', b'o' | b'O', ..] => prefixed_integer(&raw[2..], 8)?,
        [b'0', b'b' | b'B', ..] => prefixed_integer(&raw[2..], 2)?,
        _ => raw.parse::<f64>().ok()?,
    };
    (is_safe_integer(number) && number > 0.0).then_some(number as u64)
}

fn prefixed_integer(digits: &str, radix: u32) -> Option<f64> {
    if digits.starts_with('+') {
        return None;
    }
    u64::from_str_radix(digits, radix)
        .ok()
        .map(|value| value as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(text: &str) -> Result<RawMessagesQuery, DomainError> {
        raw_messages_query(
            &Url::parse(&format!("http://localhost/api/v1/chats/messages?{text}")).unwrap(),
        )
    }

    #[test]
    fn raw_limit_is_number_coerced_capped_and_uses_the_first_value() {
        for (value, expected) in [
            ("", 20),
            ("%EF%BB%BF", 20),
            ("%20%2B2e2%20", 200),
            ("0x20", 32),
            ("0O10", 8),
            ("0b10", 2),
            ("2.0", 2),
            ("9007199254740991", 200),
        ] {
            assert_eq!(
                query(&format!("limit={value}&limit=invalid"))
                    .unwrap()
                    .limit,
                expected,
                "{value}"
            );
        }
        for value in ["2.5", "0", "-1", "9007199254740992", "%2B0x10", "0x%2B10"] {
            assert_eq!(
                query(&format!("limit={value}")).unwrap_err().message,
                "limit must be a positive integer",
                "{value}"
            );
        }
    }

    #[test]
    fn raw_cursor_requires_a_view_and_disallows_activation() {
        let valid = query("beforeOrdinal=0x10&transcriptViewId=%20my-view%20").unwrap();
        assert_eq!(valid.before_ordinal, Some(16));
        assert_eq!(valid.expected_view_id.as_deref(), Some("my-view"));
        for (text, message) in [
            (
                "beforeOrdinal=0",
                "beforeOrdinal must be a positive integer",
            ),
            (
                "beforeOrdinal=1&purpose=activation",
                "transcriptViewId query parameter is required for earlier pages",
            ),
            (
                "beforeOrdinal=1&transcriptViewId=v&purpose=activation",
                "activation purpose is valid only for newest history",
            ),
            ("purpose=", "purpose must be activation"),
        ] {
            assert_eq!(query(text).unwrap_err().message, message);
        }
    }
}
