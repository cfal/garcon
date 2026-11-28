//! Ports `server/controller/routes/chat-rows.ts`.

use std::{error::Error, rc::Rc};

use garcon_base::{
    domain_error::{DomainError, as_domain_error},
    errors::ErrorInput,
    http_body::{MalformedJsonError, fetch_header_value},
    http_error::json_error_from_unknown,
};
use garcon_chats::chat_row_service::ChatRowService;
use garcon_contract::{
    chat_id::parse_chat_id,
    chat_row_contracts::{
        AddChatRowRequest, ChatRowUnpairedSurrogates,
        parse_add_chat_row_request_with_unpaired_surrogates,
    },
};
use garcon_js::json::parse_with_unpaired_surrogate_fields;
use http::{
    HeaderValue, Method, StatusCode,
    header::{CACHE_CONTROL, CONTENT_TYPE},
};
use http_body_util::BodyExt;
use serde_json::Value;

use crate::{
    compose_routes::RouteMap,
    http_route_types::{Route, RouteResult},
    json_route::json_response,
    listener::HttpRequest,
};

pub fn create_chat_row_routes(service: &Rc<ChatRowService>) -> RouteMap<Route> {
    let targets = Rc::clone(service);
    let get = Route::new(Default::default(), move |request, url, _| {
        let service = Rc::clone(&targets);
        async move {
            let result = async {
                let raw_id = url
                    .query_pairs()
                    .find_map(|(key, value)| (key == "chatId").then_some(value))
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        DomainError::new_validation("chatId query parameter is required")
                    })?;
                let chat_id = parse_chat_id(&Value::String(raw_id.into_owned()))
                    .map_err(|error| DomainError::new_validation(error.to_string()))?;
                let response = service
                    .target(chat_id.as_str(), request.body().cancellation())
                    .await?;
                Ok(json_response(StatusCode::OK, &response)?)
            }
            .await;
            no_store(result)
        }
    });
    let rows = Rc::clone(service);
    let post = Route::new(Default::default(), move |request, _, _| {
        let service = Rc::clone(&rows);
        async move {
            let signal = request.body().cancellation().clone();
            let input = match read_chat_row_request(request).await {
                Ok(input) => input,
                Err(error) if as_domain_error(error.as_ref()).is_some() => {
                    return no_store(Err(error));
                }
                Err(error) => return Err(error),
            };
            let result = async {
                let response = service.add(input, &signal).await?;
                Ok(json_response(StatusCode::OK, &response)?)
            }
            .await;
            no_store(result)
        }
    });
    RouteMap::from([(
        "/api/v1/chats/rows".into(),
        [(Method::GET, get), (Method::POST, post)].into(),
    )])
}

fn no_store(result: RouteResult) -> RouteResult {
    let mut reply = match result {
        Ok(reply) => reply,
        Err(error) => {
            json_error_from_unknown(ErrorInput::Error(error.as_ref()), None, None, None)?.map(Some)
        }
    };
    reply
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(reply)
}

async fn read_chat_row_request(request: HttpRequest) -> Result<AddChatRowRequest, Box<dyn Error>> {
    let json = fetch_header_value(request.headers(), &CONTENT_TYPE)
        .is_some_and(|media| media.to_lowercase().contains("application/json"));
    if !json {
        return parse_chat_row_body("");
    }
    let bytes = request
        .into_body()
        .collect()
        .await
        .map_err(|error| error as Box<dyn Error>)?
        .to_bytes();
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes);
    parse_chat_row_body(&String::from_utf8_lossy(bytes))
}

fn parse_chat_row_body(text: &str) -> Result<AddChatRowRequest, Box<dyn Error>> {
    let (value, [title, content]) = if text.is_empty() {
        (Value::Object(Default::default()), [false; 2])
    } else {
        parse_with_unpaired_surrogate_fields(text, ["title", "content"])
            .map_err(|_| MalformedJsonError)?
    };
    Ok(parse_add_chat_row_request_with_unpaired_surrogates(
        &value,
        ChatRowUnpairedSurrogates { title, content },
    )
    .map_err(|error| DomainError::new_validation(error.to_string()))?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(title: &str, content: &str) -> String {
        format!(
            r#"{{"clientRequestId":"request","clientMessageId":"message",
                "chatId":"1000000000000001","transcriptViewId":"view",
                "presentation":{{"style":"notice"}},"format":"plain","disclosure":"expanded",
                "title":{title},"content":{content},"ignored":"\ud800"}}"#
        )
    }

    #[test]
    fn rejects_only_unpaired_title_or_content_before_the_row_service() {
        for (title, content, field) in [
            (r#""\ud800\nsecond""#, r#""\ufffd""#, "title"),
            (r#""\ufffd""#, r#""\udc00""#, "content"),
            (r#""\ud800""#, r#""\udc00""#, "title"),
        ] {
            let error = parse_chat_row_body(&body(title, content)).unwrap_err();
            let error = garcon_base::domain_error::as_domain_error(error.as_ref()).unwrap();
            assert_eq!(
                error.message,
                format!("{field} must contain well-formed Unicode")
            );
        }
        let accepted =
            parse_chat_row_body(&body(r#""\ufffd""#, r#""\ufffd\ud83d\ude80""#)).unwrap();
        assert_eq!(accepted.title.as_deref(), Some("\u{fffd}"));
        assert_eq!(accepted.content, "\u{fffd}\u{1f680}");
    }
}
