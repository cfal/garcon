//! Title fallback shared by the chat read projections.

use garcon_js::js::trim;

const DEFAULT_TITLE: &str = "New Session";

pub fn resolve_chat_title<'a>(name: Option<&'a str>, first_message: Option<&'a str>) -> &'a str {
    let text = name
        .filter(|name| !name.is_empty())
        .or(first_message)
        .unwrap_or_default();
    match extract_first_line(text) {
        "" => DEFAULT_TITLE,
        line => line,
    }
}

pub(crate) fn extract_first_line(text: &str) -> &str {
    trim(text.split_once('\n').map_or(text, |(line, _)| line))
}
