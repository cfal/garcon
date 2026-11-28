//! Ports `common/attachments.ts`.

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize, Serializer, de};

use garcon_js::trim;

/// Image types sent to image-capable providers as image content. Other
/// `image/*` types, such as HEIC or TIFF, are ordinary files.
pub const IMAGE_ATTACHMENT_MIME_TYPES: &[&str] = &[
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/svg+xml",
    "image/webp",
];

pub const TEXT_FILE_ATTACHMENT_MIME_TYPES: &[&str] = &[
    "text/csv",
    "text/markdown",
    "text/plain",
    "text/tab-separated-values",
];

pub const DOCUMENT_FILE_ATTACHMENT_MIME_TYPES: &[&str] = &["application/pdf"];

pub const VIDEO_FILE_ATTACHMENT_MIME_TYPES: &[&str] = &[
    "video/mp4",
    "video/quicktime",
    "video/webm",
    "video/x-matroska",
];

/// Agents that read attachments from disk with their own tools accept every
/// file type rather than a fixed list.
pub const ANY_FILE_ATTACHMENT_MIME_TYPE: &str = "any";

pub const MAX_CHAT_ATTACHMENT_COUNT: u64 = 5;
pub const MAX_CHAT_ATTACHMENT_TOTAL_BYTES: u64 = 25 * 1024 * 1024;
pub const MAX_CHAT_ATTACHMENT_FILE_BYTES: u64 = 10 * 1024 * 1024;
pub const MAX_CHAT_VIDEO_ATTACHMENT_FILE_BYTES: u64 = 25 * 1024 * 1024;
pub const MAX_CHAT_ATTACHMENT_NAME_BYTES: u64 = 255;
/// Text attachments larger than this cannot be inlined into a prompt whole.
pub const MAX_INLINE_TEXT_ATTACHMENT_BYTES: u64 = 120_000;

/// The non-image file types an agent accepts: every file type (`"any"` on the
/// wire) or a fixed list of MIME types.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum FileAttachmentMimeTypes {
    Any,
    Listed(Vec<String>),
    /// A text that is neither `"any"` nor a list, which the declared type
    /// leaves no room for. The original reads one as text: it takes a MIME
    /// type it holds, and it counts as support unless it is empty.
    Text(String),
}

impl Serialize for FileAttachmentMimeTypes {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            FileAttachmentMimeTypes::Any => serializer.serialize_str(ANY_FILE_ATTACHMENT_MIME_TYPE),
            FileAttachmentMimeTypes::Listed(types) => types.serialize(serializer),
            FileAttachmentMimeTypes::Text(text) => serializer.serialize_str(text),
        }
    }
}

impl<'de> Deserialize<'de> for FileAttachmentMimeTypes {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;

        impl<'de> de::Visitor<'de> for Visitor {
            type Value = FileAttachmentMimeTypes;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("\"any\", an array of MIME types, or a text")
            }

            fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
                if value == ANY_FILE_ATTACHMENT_MIME_TYPE {
                    Ok(FileAttachmentMimeTypes::Any)
                } else {
                    Ok(FileAttachmentMimeTypes::Text(value.to_owned()))
                }
            }

            fn visit_seq<A: de::SeqAccess<'de>>(
                self,
                sequence: A,
            ) -> Result<Self::Value, A::Error> {
                Vec::<String>::deserialize(de::value::SeqAccessDeserializer::new(sequence))
                    .map(FileAttachmentMimeTypes::Listed)
            }
        }

        deserializer.deserialize_any(Visitor)
    }
}

fn mime_type_by_extension(extension: &str) -> Option<&'static str> {
    Some(match extension {
        "csv" => "text/csv",
        "gif" => "image/gif",
        "jpeg" | "jpg" => "image/jpeg",
        "m4v" => "video/mp4",
        "markdown" | "md" => "text/markdown",
        "mkv" => "video/x-matroska",
        "mov" => "video/quicktime",
        "mp4" => "video/mp4",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "tsv" => "text/tab-separated-values",
        "txt" => "text/plain",
        "webm" => "video/webm",
        "webp" => "image/webp",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        _ => return None,
    })
}

fn extension_by_mime_type(mime_type: &str) -> Option<&'static str> {
    Some(match mime_type {
        "application/pdf" => "pdf",
        "application/vnd.ms-excel" => "xls",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => "xlsx",
        "image/gif" => "gif",
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/svg+xml" => "svg",
        "image/webp" => "webp",
        "text/csv" => "csv",
        "text/markdown" => "md",
        "text/plain" => "txt",
        "text/tab-separated-values" => "tsv",
        "video/mp4" => "mp4",
        "video/quicktime" => "mov",
        "video/webm" => "webm",
        "video/x-matroska" => "mkv",
        _ => return None,
    })
}

fn mime_type_alias(mime_type: &str) -> Option<&'static str> {
    Some(match mime_type {
        "video/matroska" => "video/x-matroska",
        "video/x-m4v" => "video/mp4",
        _ => return None,
    })
}

// Without the `u` flag the pattern runs on code units, and its classes are ASCII.
static MIME_TYPE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[a-z0-9][a-z0-9!#$&^_.+-]*[/][a-z0-9][a-z0-9!#$&^_.+-]*$")
        .expect("MIME_TYPE_RE compiles")
});

/// The MIME type of a chat attachment. `declared_type` is the type the
/// browser reports, if any.
///
/// A known extension outranks the declared type because browsers disagree on
/// common files: Windows Chrome declares CSV as `application/vnd.ms-excel`. A
/// declared image type is kept, since providers check it against the bytes.
pub fn chat_attachment_mime_type(name: &str, declared_type: Option<&str>) -> String {
    let raw_declared = declared_type.map(trim).unwrap_or_default().to_lowercase();
    let declared = mime_type_alias(&raw_declared).unwrap_or(raw_declared.as_str());
    if is_image_attachment_mime_type(declared) {
        return declared.to_owned();
    }
    // The last dot-separated piece of the name, which is the whole name
    // without a dot and empty for an empty name.
    let extension = name.rsplit('.').next().unwrap_or_default().to_lowercase();
    mime_type_by_extension(&extension)
        .map(str::to_owned)
        .unwrap_or_else(|| {
            if declared.is_empty() {
                "application/octet-stream".to_owned()
            } else {
                declared.to_owned()
            }
        })
}

/// The file extension a MIME type is attached with, when the chat knows it.
pub fn chat_attachment_extension(mime_type: &str) -> Option<&'static str> {
    extension_by_mime_type(&mime_type.to_lowercase())
}

/// Whether `mime_type` is a well-formed MIME type.
pub fn is_valid_attachment_mime_type(mime_type: &str) -> bool {
    MIME_TYPE_RE.is_match(mime_type)
}

pub fn is_image_attachment_mime_type(mime_type: &str) -> bool {
    IMAGE_ATTACHMENT_MIME_TYPES.contains(&mime_type.to_lowercase().as_str())
}

pub fn is_text_attachment_mime_type(mime_type: &str) -> bool {
    TEXT_FILE_ATTACHMENT_MIME_TYPES.contains(&mime_type.to_lowercase().as_str())
}

pub fn is_video_attachment_mime_type(mime_type: &str) -> bool {
    VIDEO_FILE_ATTACHMENT_MIME_TYPES.contains(&mime_type.to_lowercase().as_str())
}

/// Whether an agent that accepts `supported` file types takes `mime_type`.
pub fn accepts_file_attachment_mime_type(
    supported: &FileAttachmentMimeTypes,
    mime_type: &str,
) -> bool {
    match supported {
        FileAttachmentMimeTypes::Any => true,
        FileAttachmentMimeTypes::Listed(types) => {
            let mime_type = mime_type.to_lowercase();
            types.iter().any(|accepted| accepted == &mime_type)
        }
        FileAttachmentMimeTypes::Text(text) => text.contains(&mime_type.to_lowercase()),
    }
}

/// Whether an agent takes file attachments at all.
pub fn has_file_attachment_support(supported: &FileAttachmentMimeTypes) -> bool {
    match supported {
        FileAttachmentMimeTypes::Any => true,
        FileAttachmentMimeTypes::Listed(types) => !types.is_empty(),
        // `supported.length > 0`, which a text has when it is not empty.
        FileAttachmentMimeTypes::Text(text) => !text.is_empty(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn infers_video_mime_from_the_name_when_the_browser_supplies_no_specific_type() {
        for (name, expected) in [
            ("clip.mov", "video/quicktime"),
            ("clip.mkv", "video/x-matroska"),
            ("clip.m4v", "video/mp4"),
            ("clip.mp4", "video/mp4"),
            ("clip.WEBM", "video/webm"),
        ] {
            for declared in [None, Some(""), Some("application/octet-stream")] {
                assert_eq!(
                    chat_attachment_mime_type(name, declared),
                    expected,
                    "{name} {declared:?}"
                );
            }
        }
    }

    #[test]
    fn prefers_a_known_extension_over_the_browser_type_and_keeps_the_declared_type_otherwise() {
        assert_eq!(
            chat_attachment_mime_type("table.csv", Some("application/vnd.ms-excel")),
            "text/csv"
        );
        assert_eq!(
            chat_attachment_mime_type("budget.xlsx", Some("")),
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        assert_eq!(
            chat_attachment_mime_type("slides.key", Some("application/x-iwork-keynote-sffkey")),
            "application/x-iwork-keynote-sffkey"
        );
        assert_eq!(
            chat_attachment_mime_type("payload", Some("")),
            "application/octet-stream"
        );
        assert_eq!(
            chat_attachment_mime_type("payload", None),
            "application/octet-stream"
        );
    }

    #[test]
    fn treats_only_natively_supported_image_types_as_images() {
        assert!(is_image_attachment_mime_type("image/png"));
        assert!(!is_image_attachment_mime_type("image/heic"));
        assert!(!is_image_attachment_mime_type("image/tiff"));
        // A declared image type is kept even when the name says otherwise.
        assert_eq!(
            chat_attachment_mime_type("table.csv", Some("image/png")),
            "image/png"
        );
        // Trimmed and in lower case, as the browser may pad it.
        assert_eq!(
            chat_attachment_mime_type("x", Some("  IMAGE/WEBP ")),
            "image/webp"
        );
    }

    #[test]
    fn accepts_every_file_type_for_any_file_agents_and_only_listed_types_otherwise() {
        assert!(accepts_file_attachment_mime_type(
            &FileAttachmentMimeTypes::Any,
            "application/zip"
        ));
        let listed = FileAttachmentMimeTypes::Listed(vec!["text/csv".to_owned()]);
        assert!(accepts_file_attachment_mime_type(&listed, "TEXT/CSV"));
        assert!(!accepts_file_attachment_mime_type(
            &listed,
            "application/zip"
        ));
        assert!(has_file_attachment_support(&FileAttachmentMimeTypes::Any));
        assert!(has_file_attachment_support(&listed));
        assert!(!has_file_attachment_support(
            &FileAttachmentMimeTypes::Listed(Vec::new())
        ));
    }

    #[test]
    fn maps_extensions_mime_types_and_aliases() {
        for (mime_type, extension) in [
            ("application/pdf", "pdf"),
            ("image/jpeg", "jpg"),
            ("text/markdown", "md"),
            ("video/x-matroska", "mkv"),
        ] {
            assert_eq!(chat_attachment_extension(mime_type), Some(extension));
            assert_eq!(
                chat_attachment_extension(&mime_type.to_uppercase()),
                Some(extension)
            );
        }
        assert_eq!(chat_attachment_extension("application/zip"), None);
        assert_eq!(chat_attachment_extension(""), None);
        // A declared alias is read as the type it names.
        assert_eq!(
            chat_attachment_mime_type("clip", Some("video/matroska")),
            "video/x-matroska"
        );
        assert_eq!(
            chat_attachment_mime_type("clip", Some("video/x-m4v")),
            "video/mp4"
        );
        // Without a dot the whole name is the extension.
        assert_eq!(chat_attachment_mime_type("png", None), "image/png");
        assert_eq!(
            chat_attachment_mime_type("", None),
            "application/octet-stream"
        );
        assert_eq!(chat_attachment_mime_type(".png", None), "image/png");
        assert_eq!(
            chat_attachment_mime_type("archive.tar.gz", None),
            "application/octet-stream"
        );
        assert!(is_text_attachment_mime_type("Text/Plain"));
        assert!(is_video_attachment_mime_type("VIDEO/MP4"));
        assert!(!is_video_attachment_mime_type("video/matroska"));
    }

    #[test]
    fn validates_mime_types() {
        for valid in [
            "a/b",
            "image/svg+xml",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "x!#$&^_.+-/y",
        ] {
            assert!(is_valid_attachment_mime_type(valid), "{valid}");
        }
        for invalid in [
            "", "/b", "a/", "A/b", "a/B", " a/b", "a/b ", "é/b", "a/b c", "*/*", "a/b/c",
        ] {
            assert!(!is_valid_attachment_mime_type(invalid), "{invalid:?}");
        }
    }

    #[test]
    fn a_text_that_is_neither_any_nor_a_list_is_read_as_text() {
        let text = FileAttachmentMimeTypes::Text("xtext/csv".to_owned());
        // A MIME type the text holds is accepted, also as part of a longer type.
        assert!(accepts_file_attachment_mime_type(&text, "TEXT/CSV"));
        assert!(!accepts_file_attachment_mime_type(&text, "application/zip"));
        assert!(has_file_attachment_support(&text));
        let empty = FileAttachmentMimeTypes::Text(String::new());
        assert!(!has_file_attachment_support(&empty));
    }

    #[test]
    fn lowercases_as_javascript_does() {
        // The Kelvin sign, the Angstrom sign, and the dotted capital I each
        // lower to other code points; a symbol for a letter is not that letter.
        assert_eq!(
            chat_attachment_mime_type("clip", Some("video/x-matros\u{212A}a")),
            "video/x-matroska"
        );
        assert_eq!(
            chat_attachment_mime_type("x", Some("\u{212B}/b")),
            "\u{E5}/b"
        );
        assert_eq!(
            chat_attachment_mime_type("x", Some("x/\u{130}")),
            "x/i\u{307}"
        );
        assert!(!is_image_attachment_mime_type("\u{1D62}mage/png"));
        assert!(!is_image_attachment_mime_type("image/png\u{A0}"));
        // `trim` also removes a byte-order mark and line terminators.
        assert_eq!(
            chat_attachment_mime_type("x", Some("\u{FEFF}image/png")),
            "image/png"
        );
        assert_eq!(
            chat_attachment_mime_type("x", Some("image/png\n")),
            "image/png"
        );
    }

    #[test]
    fn file_attachment_mime_types_read_and_write_their_wire_form() {
        assert_eq!(
            serde_json::to_value(FileAttachmentMimeTypes::Any).unwrap(),
            serde_json::json!("any")
        );
        let listed = FileAttachmentMimeTypes::Listed(vec!["text/csv".to_owned()]);
        assert_eq!(
            serde_json::to_value(&listed).unwrap(),
            serde_json::json!(["text/csv"])
        );
        let text = FileAttachmentMimeTypes::Text("other".to_owned());
        assert_eq!(
            serde_json::to_value(&text).unwrap(),
            serde_json::json!("other")
        );
        assert_eq!(
            serde_json::from_value::<FileAttachmentMimeTypes>(serde_json::json!("any")).unwrap(),
            FileAttachmentMimeTypes::Any
        );
        assert_eq!(
            serde_json::from_value::<FileAttachmentMimeTypes>(serde_json::json!([])).unwrap(),
            FileAttachmentMimeTypes::Listed(Vec::new())
        );
        assert_eq!(
            serde_json::from_value::<FileAttachmentMimeTypes>(serde_json::json!("other")).unwrap(),
            text
        );
        assert!(serde_json::from_value::<FileAttachmentMimeTypes>(serde_json::json!(5)).is_err());
    }
}
