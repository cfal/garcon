//! Ports `server-agents/common/src/shared/native-message-source.ts`, which
//! re-exports the interface module.

pub use garcon_interface::native_message_source::{
    NativeMessageSource, attach_native_message_source, attach_native_source_to_messages,
    get_native_message_revision_source, get_native_message_source,
};
