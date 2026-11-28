//! Ports `server-agents/common/src/shared/attachment-files.ts`.

use std::{borrow::Cow, future::Future};

use garcon_contract::attachments::chat_attachment_extension;
use garcon_interface::resources::ExecutorResult;
use garcon_js::path::native;
use garcon_js::{number_to_string, trim, utf16};
use serde_json::Value;

use super::attachments::{
    AttachmentInput, attachment_mime_type, buffer_base64, parse_attachment_data_url,
};

#[derive(Clone)]
pub struct AttachmentFile<'a> {
    pub attachment: AttachmentInput<'a>,
    pub path: String,
}

#[derive(Default)]
pub struct MaterializedAttachmentFiles<'a> {
    pub files: Vec<AttachmentFile<'a>>,
    /// The directory written into, absent when nothing was written.
    directory: Option<String>,
}

impl MaterializedAttachmentFiles<'_> {
    /// Removes the files written, whatever has become of them.
    pub async fn cleanup(&self) {
        cleanup_directory(self.directory.as_deref()).await;
    }

    /// Returns cleanup that outlives the attachment input. Dropping it does not remove anything.
    pub fn into_cleanup(self) -> impl Future<Output = ()> + 'static + use<> {
        let directory = self.directory;
        async move { cleanup_directory(directory.as_deref()).await }
    }
}

async fn cleanup_directory(directory: Option<&str>) {
    if let Some(directory) = directory {
        let _ = tokio::fs::remove_dir_all(directory).await;
    }
}

const MAX_STEM_CHARS: usize = 64;

/// Writes attachments into a private temporary directory on the executor so
/// agents can open them with their own tools. File names keep the extension,
/// which agents use to choose a reader for formats such as XLSX.
pub async fn materialize_attachment_files<'a>(
    directory_prefix: &str,
    attachments: &[AttachmentInput<'a>],
) -> ExecutorResult<MaterializedAttachmentFiles<'a>> {
    if attachments.is_empty() {
        return Ok(MaterializedAttachmentFiles::default());
    }
    let directory = tempfile::Builder::new()
        .prefix(&format!("{directory_prefix}-"))
        .tempdir_in(std::env::temp_dir())?;
    let path = directory.path().to_string_lossy().into_owned();
    let files = write_attachments(&path, attachments).await?;
    let _ = directory.keep();
    Ok(MaterializedAttachmentFiles {
        files,
        directory: Some(path),
    })
}

async fn write_attachments<'a>(
    directory: &str,
    attachments: &[AttachmentInput<'a>],
) -> ExecutorResult<Vec<AttachmentFile<'a>>> {
    let mut files = Vec::new();
    for (index, attachment) in attachments.iter().enumerate() {
        let Some(parts) = parse_attachment_data_url(Some(attachment.data)) else {
            continue;
        };
        let file_path =
            native::join(&[directory, &attachment_file_name(*attachment, index as f64)]);
        tokio::fs::write(&file_path, buffer_base64(parts.base64)).await?;
        files.push(AttachmentFile {
            attachment: *attachment,
            path: file_path,
        });
    }
    Ok(files)
}

/// Prefixes the index so two attachments with the same name stay distinct.
/// Agents paste these paths into shell commands, so names keep only characters
/// that are inert in every shell, whether quoted or not. The MIME type decides
/// the extension when known; otherwise a plain original extension is kept.
pub fn attachment_file_name(attachment: AttachmentInput<'_>, index: f64) -> String {
    let name = attachment
        .name
        .map(|name| name.replace('\\', "/"))
        .unwrap_or_default();
    let base_name = native::basename(&name);
    let original_extension = extension(&base_name);
    let plain_extension = original_extension
        .strip_prefix('.')
        .unwrap_or_default()
        .to_lowercase();
    let extension = chat_attachment_extension(&attachment_mime_type(attachment))
        .map(str::to_owned)
        .or_else(|| is_safe_extension(&plain_extension).then_some(plain_extension));
    let stem = utf16::slice(
        &base_name,
        0,
        Some(utf16::len(&base_name) as isize - utf16::len(original_extension) as isize),
    );
    let stem = replace_unsafe(stem);
    let stem = stem.trim_start_matches(['.', '_', '-']);
    let stem = utf16::truncate(stem, MAX_STEM_CHARS);
    let stem = if stem.is_empty() { "attachment" } else { stem };
    let extension = extension.map_or_else(String::new, |extension| format!(".{extension}"));
    format!("{}-{stem}{extension}", number_to_string(index + 1.0))
}

/// Appends where the files were written to the command, with each original
/// name as JSON-quoted text so the agent can refer to it without it ever
/// appearing in a path.
pub fn append_attachment_file_references<'a>(
    command: &'a str,
    files: &[AttachmentFile<'_>],
) -> Cow<'a, str> {
    if files.is_empty() {
        return Cow::Borrowed(command);
    }
    let references = files
        .iter()
        .map(
            |file| match file.attachment.name.filter(|name| !name.is_empty()) {
                Some(name) => format!(
                    "- {} (original name: {})",
                    file.path,
                    garcon_js::json::stringify(&Value::String(name.to_owned()))
                ),
                None => format!("- {}", file.path),
            },
        )
        .collect::<Vec<_>>()
        .join("\n");
    Cow::Owned(
        [
            command,
            "Attached files are available on disk:",
            &references,
        ]
        .into_iter()
        .filter(|part| !trim(part).is_empty())
        .collect::<Vec<_>>()
        .join("\n\n"),
    )
}

fn is_safe_extension(extension: &str) -> bool {
    (1..=16).contains(&extension.len())
        && extension
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
}

// `[^A-Za-z0-9._-]+`: each run of characters that are not inert becomes one underscore.
fn replace_unsafe(stem: &str) -> Cow<'_, str> {
    if stem.bytes().all(is_inert) {
        return Cow::Borrowed(stem);
    }
    let mut replaced = String::with_capacity(stem.len());
    let mut in_run = false;
    for character in stem.chars() {
        if character.is_ascii() && is_inert(character as u8) {
            replaced.push(character);
            in_run = false;
        } else if !in_run {
            replaced.push('_');
            in_run = true;
        }
    }
    Cow::Owned(replaced)
}

fn is_inert(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')
}

// `path.extname` of a base name, which holds no path separator: the part from
// the last dot, unless only dots precede it or nothing does.
fn extension(base_name: &str) -> &str {
    let bytes = base_name.as_bytes();
    let mut start_dot: Option<usize> = None;
    let mut pre_dot_state = 0;
    for index in (0..bytes.len()).rev() {
        if bytes[index] == b'.' {
            if start_dot.is_none() {
                start_dot = Some(index);
            } else if pre_dot_state != 1 {
                pre_dot_state = 1;
            }
        } else if start_dot.is_some() {
            pre_dot_state = -1;
        }
    }
    match start_dot {
        Some(start_dot) if pre_dot_state != 0 && !(pre_dot_state == 1 && base_name == "..") => {
            &base_name[start_dot..]
        }
        _ => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OCTET_STREAM: &str = "data:application/octet-stream;base64,Ynl0ZXM=";

    // An attachment whose text the test owns.
    #[derive(Clone)]
    struct Owned {
        data: String,
        name: Option<String>,
        mime_type: Option<String>,
    }

    impl Owned {
        fn named(name: &str, mime_type: &str) -> Self {
            Self {
                data: OCTET_STREAM.to_owned(),
                name: Some(name.to_owned()),
                mime_type: Some(mime_type.to_owned()),
            }
        }

        fn input(&self) -> AttachmentInput<'_> {
            AttachmentInput {
                data: &self.data,
                name: self.name.as_deref(),
                mime_type: self.mime_type.as_deref(),
            }
        }
    }

    fn named(name: &str, mime_type: &str) -> String {
        at(&Owned::named(name, mime_type), 0.0)
    }

    fn at(owned: &Owned, index: f64) -> String {
        attachment_file_name(owned.input(), index)
    }

    #[test]
    fn keeps_the_user_file_name_inside_the_attachment_directory() {
        assert_eq!(
            named("budget.xlsx", "application/octet-stream"),
            "1-budget.xlsx"
        );
        assert_eq!(
            at(&Owned::named("../../etc/passwd", "text/plain"), 1.0),
            "2-passwd.txt"
        );
        assert_eq!(
            at(&Owned::named("C:\\Users\\me\\a:b.csv", "text/csv"), 2.0),
            "3-a_b.csv"
        );
        assert_eq!(at(&Owned::named(".env", "text/plain"), 3.0), "4-env.txt");
    }

    #[test]
    fn keeps_only_shell_inert_characters() {
        for (name, expected) in [
            ("report$(touch PWNED).csv", "1-report_touch_PWNED_.csv"),
            ("a`id`b.csv", "1-a_id_b.csv"),
            ("q\"uote's.csv", "1-q_uote_s.csv"),
            ("x; rm -rf ~ && y | z.csv", "1-x_rm_-rf_y_z.csv"),
            ("-rf.csv", "1-rf.csv"),
        ] {
            assert_eq!(named(name, "text/csv"), expected, "{name}");
        }
    }

    #[test]
    fn bounds_long_stems_and_falls_back_to_the_attachment_name() {
        let long = format!("{}.{}", "a".repeat(1_000_000), "b".repeat(1_000_000));
        assert_eq!(
            named(&long, "application/octet-stream"),
            format!("1-{}", "a".repeat(64))
        );
        assert_eq!(
            named("表格.docx", "application/octet-stream"),
            "1-attachment.docx"
        );
        assert_eq!(
            named("日本語.xlsx", "application/octet-stream"),
            "1-attachment.xlsx"
        );
        assert_eq!(named("...", "text/plain"), "1-attachment.txt");
        assert_eq!(named("....", "text/plain"), "1-attachment.txt");
        assert_eq!(named("___", "text/plain"), "1-attachment.txt");
    }

    #[test]
    fn adds_the_known_extension_when_the_name_has_none() {
        assert_eq!(named("", "image/png"), "1-attachment.png");
        assert_eq!(named("notes", "text/markdown"), "1-notes.md");
        assert_eq!(named("blob", "application/x-unknown"), "1-blob");
        assert_eq!(named("x.UPPER", "application/x-unknown"), "1-x.upper");
        assert_eq!(
            named("x.abcdefghijklmnop", "application/x-unknown"),
            "1-x.abcdefghijklmnop"
        );
        assert_eq!(named("x.abcdefghijklmnopq", "application/x-unknown"), "1-x");
        assert_eq!(named("x.a-b_c", "application/x-unknown"), "1-x");
        assert_eq!(named("a..b", "application/x-unknown"), "1-a..b");
        assert_eq!(named("a.", "application/x-unknown"), "1-a");
        assert_eq!(named(".a.tar", "application/x-unknown"), "1-a.tar");
        assert_eq!(named(".a..tar", "application/x-unknown"), "1-a..tar");
        assert_eq!(named("..a", "application/x-unknown"), "1-attachment.a");
        assert_eq!(named("..", "application/x-unknown"), "1-attachment");
        assert_eq!(named("a/b/c.txt", "application/x-unknown"), "1-c.txt");
        assert_eq!(named("a\\b\\c.txt", "application/x-unknown"), "1-c.txt");
        assert_eq!(named("dir/", "text/plain"), "1-dir.txt");
        assert_eq!(named("x.csv/", "application/x-unknown"), "1-x.csv");
        assert_eq!(named("x.é", "application/x-unknown"), "1-x");
    }

    #[test]
    fn the_index_is_printed_as_a_number_prints() {
        let plain = Owned::named("x", "application/x-unknown");
        assert_eq!(at(&plain, 0.5), "1.5-x");
        assert_eq!(at(&plain, 1e21), "1e+21-x");
        assert_eq!(at(&plain, f64::NAN), "NaN-x");
        assert_eq!(at(&plain, -1.0), "0-x");
    }

    #[tokio::test]
    async fn writes_same_named_attachments_to_distinct_files_and_removes_them_on_cleanup() {
        let first = Owned {
            data: "data:text/csv;base64,Zmlyc3Q=".to_owned(),
            name: Some("data.csv".to_owned()),
            mime_type: Some("text/csv".to_owned()),
        };
        let second = Owned {
            data: "data:text/csv;base64,c2Vjb25k".to_owned(),
            ..first.clone()
        };
        let skipped = Owned {
            data: "not a data url".to_owned(),
            name: Some("skipped.bin".to_owned()),
            mime_type: Some("application/octet-stream".to_owned()),
        };
        let attachments = [first.input(), second.input(), skipped.input()];

        let materialized = materialize_attachment_files("garcon-attachment-test", &attachments)
            .await
            .unwrap();

        assert_eq!(materialized.files.len(), 2);
        let [first_file, second_file] = &materialized.files[..] else {
            panic!("two files were written");
        };
        assert_eq!(
            native::dirname(&first_file.path),
            native::dirname(&second_file.path)
        );
        let first_bytes = tokio::fs::read(&first_file.path).await.unwrap();
        let second_bytes = tokio::fs::read(&second_file.path).await.unwrap();
        assert_eq!(first_bytes, b"first");
        assert_eq!(second_bytes, b"second");

        materialized.cleanup().await;
        assert!(
            tokio::fs::metadata(native::dirname(&first_file.path))
                .await
                .is_err()
        );
        materialized.cleanup().await;

        let none = materialize_attachment_files("garcon-attachment-test", &[])
            .await
            .unwrap();
        assert!(none.files.is_empty());
        none.cleanup().await;
    }

    #[tokio::test]
    async fn owned_cleanup_can_remove_an_empty_materialization_after_the_input_is_gone() {
        let (directory, cleanup) = {
            let invalid = Owned {
                data: "not a data url".to_owned(),
                name: None,
                mime_type: None,
            };
            let materialized =
                materialize_attachment_files("garcon-attachment-test", &[invalid.input()])
                    .await
                    .unwrap();
            assert!(materialized.files.is_empty());
            (
                materialized.directory.clone().unwrap(),
                materialized.into_cleanup(),
            )
        };
        assert!(tokio::fs::metadata(&directory).await.unwrap().is_dir());
        cleanup.await;
        assert_eq!(
            tokio::fs::metadata(&directory).await.unwrap_err().kind(),
            std::io::ErrorKind::NotFound,
        );
    }

    #[tokio::test]
    async fn dropping_uninvoked_cleanup_leaves_the_directory_untouched() {
        let input = Owned {
            data: "not a data url".to_owned(),
            name: None,
            mime_type: None,
        };
        let materialized = materialize_attachment_files("garcon-attachment-test", &[input.input()])
            .await
            .unwrap();
        let directory = materialized.directory.clone().unwrap();
        drop(materialized.into_cleanup());
        assert!(tokio::fs::metadata(&directory).await.unwrap().is_dir());
        tokio::fs::remove_dir(&directory).await.unwrap();
    }

    #[test]
    fn lists_the_original_name_as_quoted_metadata_beside_the_path() {
        let owned = |name: Option<&str>| Owned {
            data: OCTET_STREAM.to_owned(),
            name: name.map(str::to_owned),
            mime_type: Some("text/plain".to_owned()),
        };
        let budget = owned(Some("Q3 $(budget).xlsx"));
        let anonymous = owned(None);
        let quoted = owned(Some("a\"b.txt"));
        let astral = owned(Some("日本😀.txt"));
        let budget_file = AttachmentFile {
            attachment: budget.input(),
            path: "/tmp/x/1-Q3_budget_.xlsx".to_owned(),
        };
        let anonymous_file = AttachmentFile {
            attachment: anonymous.input(),
            path: "/tmp/x/1-attachment.txt".to_owned(),
        };
        let quoted_file = AttachmentFile {
            attachment: quoted.input(),
            path: "/tmp/x/1-a_b.txt".to_owned(),
        };
        let astral_file = AttachmentFile {
            attachment: astral.input(),
            path: "/tmp/x/2-attachment.txt".to_owned(),
        };

        assert_eq!(
            append_attachment_file_references("Read", std::slice::from_ref(&budget_file)),
            "Read\n\nAttached files are available on disk:\n\n- /tmp/x/1-Q3_budget_.xlsx (original name: \"Q3 $(budget).xlsx\")"
        );
        assert_eq!(append_attachment_file_references("Read", &[]), "Read");
        assert_eq!(
            append_attachment_file_references("Read", std::slice::from_ref(&anonymous_file)),
            "Read\n\nAttached files are available on disk:\n\n- /tmp/x/1-attachment.txt"
        );
        assert_eq!(
            append_attachment_file_references(" ", &[quoted_file, astral_file]),
            "Attached files are available on disk:\n\n- /tmp/x/1-a_b.txt (original name: \"a\\\"b.txt\")\n- /tmp/x/2-attachment.txt (original name: \"日本😀.txt\")"
        );
    }
}
