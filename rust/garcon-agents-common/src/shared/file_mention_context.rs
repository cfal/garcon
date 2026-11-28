//! Ports `server-agents/common/src/shared/file-mention-context.ts`, which
//! re-exports `common/file-mention-context.ts`.

pub use garcon_contract::file_mention_context::{
    FILE_CONTEXT_SEPARATOR, strip_resolved_file_mention_context,
};
