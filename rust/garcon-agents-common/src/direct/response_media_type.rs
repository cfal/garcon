//! Ports `server-agents/common/src/direct/response-media-type.ts`.

pub fn is_json_response(content_type: Option<&str>) -> bool {
    content_type
        .and_then(|header| header.split(';').next())
        .is_some_and(|media_type| {
            let media_type = garcon_js::trim(media_type);
            media_type.eq_ignore_ascii_case("application/json")
                || media_type
                    .get(media_type.len().saturating_sub(5)..)
                    .is_some_and(|suffix| suffix.eq_ignore_ascii_case("+json"))
        })
}
