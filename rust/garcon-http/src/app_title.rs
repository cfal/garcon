use std::ops::Range;
use std::sync::LazyLock;

use garcon_contract::settings::{APP_TITLE_MAX_LENGTH, DEFAULT_APP_TITLE};
use garcon_js::json::{self, Opaque};
use garcon_js::{trim, utf16};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::ser::PrettyFormatter;
use serde_json::{Map, Value};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PublicAppTitle {
    pub title: String,
    pub version: u64,
}

impl Default for PublicAppTitle {
    fn default() -> Self {
        Self {
            title: DEFAULT_APP_TITLE.to_owned(),
            version: 0,
        }
    }
}

pub fn resolve_public_app_title(ui: &Value, version: u64) -> PublicAppTitle {
    let title = ui["appIdentity"]["title"]
        .as_str()
        .map(trim)
        .filter(|title| !title.is_empty() && utf16::len(title) <= APP_TITLE_MAX_LENGTH)
        .unwrap_or(DEFAULT_APP_TITLE);
    PublicAppTitle {
        title: title.to_owned(),
        version,
    }
}

static TITLE_ELEMENT: LazyLock<Regex> = LazyLock::new(|| {
    // INFALLIBLE: the pattern is fixed.
    Regex::new(r"<title>[^<]*</title>").expect("literal HTML title pattern")
});

static APPLE_META_TITLE: LazyLock<Regex> = LazyLock::new(|| {
    const S: &str =
        r"[\t-\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]";
    // INFALLIBLE: the pattern uses the fixed ECMAScript whitespace set.
    Regex::new(&format!(
        r#"<meta{S}+name="apple-mobile-web-app-title"{S}+content="[^"]*"{S}*/?>"#
    ))
    .expect("literal HTML meta pattern")
});

pub fn escape_html(source: &str) -> String {
    let mut output = String::with_capacity(source.len());
    for ch in source.chars() {
        output.push_str(match ch {
            '&' => "&amp;",
            '<' => "&lt;",
            '>' => "&gt;",
            '"' => "&quot;",
            '\'' => "&#39;",
            _ => {
                output.push(ch);
                continue;
            }
        });
    }
    output
}

pub fn app_title_bootstrap_script(app_title: &PublicAppTitle) -> String {
    let embedded = json::stringify(&serde_json::json!({
        "title": app_title.title,
        "version": app_title.version,
    }))
    .replace('<', "\\u003c")
    .replace('\u{2028}', "\\u2028")
    .replace('\u{2029}', "\\u2029");
    format!("<script>globalThis.__GARCON_APP_TITLE__={embedded}</script>")
}

fn head_end(html: &str) -> Option<Range<usize>> {
    const END: &str = "</head>";
    let start = html.find(END)?;
    Some(start..start + END.len())
}

// The original passes a replacement string, not a callback, to JS replace.
fn replace_first(source: &str, range: Range<usize>, replacement: &str) -> String {
    let mut result = String::with_capacity(source.len() + replacement.len());
    let before = &source[..range.start];
    let after = &source[range.end..];
    result.push_str(before);
    let mut chars = replacement.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '$' {
            result.push(ch);
            continue;
        }
        match chars.peek() {
            Some('$') => result.push('$'),
            Some('&') => result.push_str(&source[range.clone()]),
            Some('`') => result.push_str(before),
            Some('\'') => result.push_str(after),
            _ => {
                result.push('$');
                continue;
            }
        }
        chars.next();
    }
    result.push_str(after);
    result
}

pub fn inject_app_title_into_shell(shell: &str, app_title: &PublicAppTitle) -> String {
    let title = escape_html(&app_title.title);
    let mut html = match TITLE_ELEMENT.find(shell) {
        Some(element) => replace_first(shell, element.range(), &format!("<title>{title}</title>")),
        None => match head_end(shell) {
            Some(end) => replace_first(
                shell,
                end,
                &format!("\t\t<title>{title}</title>\n\t</head>"),
            ),
            None => shell.to_owned(),
        },
    };
    if let Some(meta) = APPLE_META_TITLE.find(&html) {
        html = replace_first(
            &html,
            meta.range(),
            &format!("<meta name=\"apple-mobile-web-app-title\" content=\"{title}\" />"),
        );
    }
    if let Some(end) = head_end(&html) {
        let bootstrap = app_title_bootstrap_script(app_title);
        html = replace_first(&html, end, &format!("\t\t{bootstrap}\n\t</head>"));
    }
    html
}

pub fn apply_manifest_title(
    raw: &str,
    app_title: &PublicAppTitle,
) -> Result<String, serde_json::Error> {
    let mut manifest: Map<String, Value> = match json::parse(raw)? {
        Value::Object(object) => object,
        Value::Array(items) => items
            .into_iter()
            .enumerate()
            .map(|(index, value)| (index.to_string(), value))
            .collect(),
        Value::String(text) => text
            .encode_utf16()
            .enumerate()
            .map(|(index, unit)| {
                (
                    index.to_string(),
                    Value::String(String::from_utf16_lossy(&[unit])),
                )
            })
            .collect(),
        _ => Map::new(),
    };
    manifest.insert("name".into(), Value::String(app_title.title.clone()));
    manifest.insert("short_name".into(), Value::String(app_title.title.clone()));
    let mut text = Vec::new();
    let formatter = PrettyFormatter::with_indent(b"\t");
    Opaque::from_value(Value::Object(manifest)).serialize(
        &mut serde_json::Serializer::with_formatter(&mut text, formatter),
    )?;
    // INFALLIBLE: the serializer writes UTF-8.
    Ok(String::from_utf8(text).expect("serde_json writes UTF-8"))
}
