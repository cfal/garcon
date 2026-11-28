//! Replays cases from `server-agents/common/src/shared/attachment-files.ts`.

use garcon_agents_common::shared::attachment_files::{
    AttachmentFile, append_attachment_file_references, attachment_file_name,
};
use garcon_agents_common::shared::attachments::AttachmentInput;
use garcon_cases::{CaseError, javascript_number, replay, round_tripped, text};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn undeliverable(error: impl std::fmt::Display) -> CaseError {
    CaseError::undeliverable(error.to_string())
}

fn typed<T: DeserializeOwned>(function: &str, value: Option<&Value>) -> Result<T, CaseError> {
    let value = round_tripped(function, value)?
        .ok_or_else(|| undeliverable("expected the original typed argument"))?;
    serde_json::from_value(value.into_owned()).map_err(undeliverable)
}

#[derive(Deserialize)]
struct Attachment {
    data: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default, rename = "mimeType")]
    mime_type: Option<String>,
}

#[derive(Deserialize)]
struct AttachmentFileInput {
    attachment: Attachment,
    path: String,
}

impl Attachment {
    fn input(&self) -> AttachmentInput<'_> {
        AttachmentInput {
            data: &self.data,
            name: self.name.as_deref(),
            mime_type: self.mime_type.as_deref(),
        }
    }
}

#[test]
fn recorded_attachment_files_match() {
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/attachment-files"),
        |function, args| match function {
            "attachmentFileName" => {
                let attachment: Attachment = typed(function, args.first())?;
                let index = javascript_number(function, args.get(1))?;
                Ok(json!(attachment_file_name(attachment.input(), index)))
            }
            "appendAttachmentFileReferences" => {
                let command = text(function, args.first())?
                    .ok_or_else(|| undeliverable("expected a command"))?;
                let inputs: Vec<AttachmentFileInput> = typed(function, args.get(1))?;
                let files: Vec<AttachmentFile<'_>> = inputs
                    .iter()
                    .map(|input| AttachmentFile {
                        attachment: input.attachment.input(),
                        path: input.path.clone(),
                    })
                    .collect();
                Ok(json!(append_attachment_file_references(command, &files)))
            }
            _ => Err(CaseError::unhandled(function)),
        },
    );
    assert_eq!(stats.with_wildcards, 0);
}
