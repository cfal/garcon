//! Ports `common/file-mention-context.ts`.

use garcon_js::utf16;

pub const FILE_CONTEXT_SEPARATOR: &str = "\n\nReferenced file contents from @file mentions:\n\n";

pub fn strip_resolved_file_mention_context(content: &str) -> &str {
    match utf16::index_of(content, FILE_CONTEXT_SEPARATOR) {
        Some(index) => utf16::slice(content, 0, Some(index as isize)),
        None => content,
    }
}

#[cfg(test)]
mod tests {
    use garcon_cases::{CaseError, replay, text};
    use serde_json::json;

    use super::strip_resolved_file_mention_context;

    #[test]
    fn recorded_file_mention_context_matches() {
        let stats = replay(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/cases/common/file-mention-context"
            ),
            |function, args| {
                if function != "stripResolvedFileMentionContext" {
                    return Err(CaseError::unhandled(function));
                }
                let content = text(function, args.first())?
                    .ok_or_else(|| CaseError::undeliverable("expected file mention text"))?;
                Ok(json!(strip_resolved_file_mention_context(content)))
            },
        );
        assert_eq!(stats.with_wildcards, 0);
    }
}
