//! Ports `common/command-output-projection.ts`.

use std::borrow::Cow;
use std::collections::HashMap;

use indexmap::IndexMap;

use crate::chat_types::{
    ChatMessage, CommandOutputChannel, CommandOutputFormat, CommandOutputMessage,
};
use crate::command_output::CommandCapture;
use crate::transcript_notice_details::TranscriptNoticeDetail;

pub fn project_command_output(
    messages: &[Option<ChatMessage>],
) -> IndexMap<usize, Cow<'_, CommandOutputMessage>> {
    let mut output_evidence = HashMap::new();
    let mut results = HashMap::new();
    let mut last_gap = None;
    for (index, message) in messages.iter().enumerate() {
        let Some(message) = message else { continue };
        match message {
            ChatMessage::Notice(notice)
                if notice.detail == Some(TranscriptNoticeDetail::PublicationGap) =>
            {
                last_gap = Some(index);
            }
            ChatMessage::CommandResult(message) => {
                let id = message.command_id.as_str();
                let complete =
                    message.result.capture == CommandCapture::Complete && !results.contains_key(id);
                results.insert(id, (index, complete, last_gap));
            }
            ChatMessage::CommandOutput(message) => {
                let (_, stdout_count) = output_evidence
                    .entry(message.command_id.as_str())
                    .or_insert((index, 0));
                *stdout_count += usize::from(message.channel == CommandOutputChannel::Stdout);
            }
            _ => {}
        }
    }

    let mut projections = IndexMap::new();
    for (index, message) in messages.iter().enumerate() {
        let Some(ChatMessage::CommandOutput(output)) = message else {
            continue;
        };
        // INFALLIBLE: the first pass indexed every command output.
        let (first_index, stdout_count) = output_evidence[output.command_id.as_str()];
        let complete = output.channel == CommandOutputChannel::Stdout
            && output.offset == 0
            && stdout_count == 1
            && results.get(output.command_id.as_str()).is_some_and(
                |&(result_index, complete, gap)| {
                    complete && result_index > index && gap.is_none_or(|gap| gap < first_index)
                },
            );
        let projected = if output.format == CommandOutputFormat::Markdown && !complete {
            let mut literal = output.clone();
            literal.format = CommandOutputFormat::Plain;
            Cow::Owned(literal)
        } else {
            Cow::Borrowed(output)
        };
        projections.insert(index, projected);
    }
    projections
}
