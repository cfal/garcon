//! Ports `server-agents/common/src/shared/attachments.ts`.

use std::borrow::Cow;

use base64::Engine;
use base64::alphabet;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use garcon_contract::agent_execution::AgentAttachment;
use garcon_contract::attachments::{
    DOCUMENT_FILE_ATTACHMENT_MIME_TYPES, MAX_INLINE_TEXT_ATTACHMENT_BYTES,
    is_image_attachment_mime_type, is_text_attachment_mime_type,
};
use garcon_js::{trim, utf16};
use serde::Serialize;

const MAX_INLINE_ATTACHMENT_CHARS: usize = MAX_INLINE_TEXT_ATTACHMENT_BYTES as usize;
const BASE64_BUFFER: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_padding_mode(DecodePaddingMode::Indifferent)
        .with_decode_allow_trailing_bits(true),
);

#[derive(Clone, Copy)]
pub struct AttachmentInput<'a> {
    pub data: &'a str,
    pub name: Option<&'a str>,
    pub mime_type: Option<&'a str>,
}

impl<'a> From<&'a AgentAttachment> for AttachmentInput<'a> {
    fn from(attachment: &'a AgentAttachment) -> Self {
        Self {
            data: &attachment.data,
            name: attachment.name.as_deref(),
            mime_type: Some(&attachment.mime_type),
        }
    }
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataUrlParts<'a> {
    pub mime_type: String,
    pub base64: &'a str,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename = "document")]
pub struct AttachmentDocumentBlock {
    source: AttachmentDocumentSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename = "base64")]
struct AttachmentDocumentSource {
    media_type: String,
    data: String,
}

pub fn parse_attachment_data_url(data: Option<&str>) -> Option<DataUrlParts<'_>> {
    let (mime, rest) = data?.strip_prefix("data:")?.split_once(';')?;
    let base64 = rest.strip_prefix("base64,")?;
    if mime.is_empty() || base64.is_empty() || base64.contains(['\r', '\n', '\u{2028}', '\u{2029}'])
    {
        return None;
    }
    Some(DataUrlParts {
        mime_type: mime.to_lowercase(),
        base64,
    })
}

pub fn attachment_mime_type(attachment: AttachmentInput<'_>) -> String {
    attachment
        .mime_type
        .map(str::to_lowercase)
        .or_else(|| parse_attachment_data_url(Some(attachment.data)).map(|parts| parts.mime_type))
        .unwrap_or_default()
}

pub fn is_image_attachment(attachment: AttachmentInput<'_>) -> bool {
    is_image_attachment_mime_type(&attachment_mime_type(attachment))
}

pub fn image_attachments<'a>(
    attachments: impl IntoIterator<Item = AttachmentInput<'a>>,
) -> Vec<AttachmentInput<'a>> {
    attachments
        .into_iter()
        .filter(|attachment| is_image_attachment(*attachment))
        .collect()
}

pub fn non_image_attachments<'a>(
    attachments: impl IntoIterator<Item = AttachmentInput<'a>>,
) -> Vec<AttachmentInput<'a>> {
    attachments
        .into_iter()
        .filter(|attachment| !is_image_attachment(*attachment))
        .collect()
}

pub fn is_text_attachment(attachment: AttachmentInput<'_>) -> bool {
    is_text_attachment_mime_type(&attachment_mime_type(attachment))
}

pub fn fits_inline_text_attachment(attachment: AttachmentInput<'_>) -> bool {
    is_text_attachment(attachment)
        && parse_attachment_data_url(Some(attachment.data)).is_some_and(|parts| {
            let units = utf16::len(parts.base64);
            let padding = parts
                .base64
                .as_bytes()
                .iter()
                .rev()
                .take(2)
                .take_while(|byte| **byte == b'=')
                .count();
            (units.saturating_sub(padding)) * 3 / 4 <= MAX_INLINE_ATTACHMENT_CHARS
        })
}

pub fn is_document_attachment(attachment: AttachmentInput<'_>) -> bool {
    DOCUMENT_FILE_ATTACHMENT_MIME_TYPES.contains(&attachment_mime_type(attachment).as_str())
}

pub fn document_attachments<'a>(
    attachments: impl IntoIterator<Item = AttachmentInput<'a>>,
) -> Vec<AttachmentInput<'a>> {
    attachments
        .into_iter()
        .filter(|attachment| is_document_attachment(*attachment))
        .collect()
}

pub fn attachment_document_block(
    attachment: AttachmentInput<'_>,
) -> Option<AttachmentDocumentBlock> {
    let parts = parse_attachment_data_url(Some(attachment.data))?;
    Some(AttachmentDocumentBlock {
        source: AttachmentDocumentSource {
            media_type: parts.mime_type,
            data: parts.base64.to_owned(),
        },
        title: attachment
            .name
            .filter(|name| !name.is_empty())
            .map(str::to_owned),
    })
}

pub fn append_text_attachment_context<'a>(
    command: &'a str,
    attachments: impl IntoIterator<Item = AttachmentInput<'a>>,
) -> Cow<'a, str> {
    let mut sections = Vec::new();
    for attachment in non_image_attachments(attachments) {
        let Some(parts) = parse_attachment_data_url(Some(attachment.data)) else {
            continue;
        };
        let mime_type = attachment_mime_type(attachment);
        if !is_text_attachment_mime_type(&mime_type) {
            continue;
        }
        let bytes = buffer_base64(parts.base64);
        let text = String::from_utf8_lossy(&bytes);
        let truncated = utf16::len(&text) > MAX_INLINE_ATTACHMENT_CHARS;
        let text = if truncated {
            Cow::Owned(String::from_utf16_lossy(
                &text
                    .encode_utf16()
                    .take(MAX_INLINE_ATTACHMENT_CHARS)
                    .collect::<Vec<_>>(),
            ))
        } else {
            text
        };
        let suffix = if truncated {
            "\n[Attachment truncated by Garcon before sending.]"
        } else {
            ""
        };
        let name = attachment.name.unwrap_or("attachment");
        sections.push(format!("<attached-file name=\"{name}\" mime=\"{mime_type}\">\n{text}\n{suffix}\n</attached-file>"));
    }
    if sections.is_empty() {
        return Cow::Borrowed(command);
    }
    Cow::Owned(
        std::iter::once(command)
            .chain(sections.iter().map(String::as_str))
            .filter(|part| !trim(part).is_empty())
            .collect::<Vec<_>>()
            .join("\n\n"),
    )
}

fn buffer_base64(input: &str) -> Vec<u8> {
    // Node's Buffer accepts either alphabet, ignores other characters, and stops at padding.
    let mut filtered: Vec<_> = input
        .bytes()
        .take_while(|byte| *byte != b'=')
        .filter_map(|byte| match byte {
            b'-' => Some(b'+'),
            b'_' => Some(b'/'),
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/' => Some(byte),
            _ => None,
        })
        .collect();
    if filtered.len() % 4 == 1 {
        filtered.pop();
    }
    BASE64_BUFFER.decode(filtered).unwrap_or_default()
}
