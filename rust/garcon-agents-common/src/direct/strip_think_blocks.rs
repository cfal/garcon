//! Ports `server-agents/common/src/direct/strip-think-blocks.ts`.

use std::sync::LazyLock;

use regress::Regex;

static THINK_TAG_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    // INFALLIBLE: this constant is the original's tested JavaScript expression.
    Regex::with_flags(r"<(/?)think\b[^>]*>", "i").expect("valid reasoning block expression")
});

pub fn strip_think_blocks(text: &str) -> String {
    let mut visible = String::new();
    let mut depth = 0;
    let mut flush_from = 0;
    for tag in THINK_TAG_PATTERN.find_iter(text) {
        if tag.group(1).is_some_and(|group| &text[group] == "/") {
            if depth > 0 {
                depth -= 1;
            } else {
                // An orphan close ends reasoning whose opening tag was not returned.
                visible.clear();
            }
            if depth == 0 {
                flush_from = tag.range().end;
            }
        } else {
            if depth == 0 {
                visible.push_str(&text[flush_from..tag.range().start]);
            }
            depth += 1;
        }
    }
    if depth == 0 {
        visible.push_str(&text[flush_from..]);
    }
    garcon_js::trim(&visible).to_owned()
}
