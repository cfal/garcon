use garcon_agents_common::shared::{
    attachment_files::{
        MaterializedAttachmentFiles, append_attachment_file_references,
        materialize_attachment_files,
    },
    attachments::{
        AttachmentInput, fits_inline_text_attachment, is_document_attachment, is_image_attachment,
    },
};
use garcon_contract::agent_execution::AgentAttachment;
use garcon_interface::resources::ExecutorResult;

pub struct MaterializedClaudeDiskAttachments<'a> {
    pub command: String,
    pub inline_attachments: Vec<AttachmentInput<'a>>,
    files: MaterializedAttachmentFiles<'a>,
}

impl MaterializedClaudeDiskAttachments<'_> {
    pub fn file_paths(&self) -> impl Iterator<Item = &str> {
        self.files.files.iter().map(|file| file.path.as_str())
    }

    pub async fn cleanup(&self) {
        self.files.cleanup().await;
    }
}

pub async fn materialize_claude_disk_attachments<'a>(
    command: &str,
    attachments: &'a [AgentAttachment],
) -> ExecutorResult<MaterializedClaudeDiskAttachments<'a>> {
    let (inline_attachments, disk_attachments): (Vec<_>, Vec<_>) = attachments
        .iter()
        .map(AttachmentInput::from)
        .partition(|attachment| {
            is_image_attachment(*attachment)
                || is_document_attachment(*attachment)
                || fits_inline_text_attachment(*attachment)
        });
    let files = materialize_attachment_files("claude-attachments", &disk_attachments).await?;
    Ok(MaterializedClaudeDiskAttachments {
        command: append_attachment_file_references(command, &files.files).into_owned(),
        inline_attachments,
        files,
    })
}

#[cfg(test)]
mod tests {
    use garcon_contract::agent_execution::AgentAttachmentKind;
    use garcon_js::path::native::basename;
    use serde_json::json;
    use tokio::{fs, process::Command};

    use super::*;

    const XLSX: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

    fn attachment(name: &str, mime_type: &str, base64: &str) -> AgentAttachment {
        AgentAttachment {
            kind: AgentAttachmentKind::Image,
            name: Some(name.to_owned()),
            mime_type: mime_type.to_owned(),
            data: format!("data:{mime_type};base64,{base64}"),
        }
    }

    #[tokio::test]
    async fn adds_readable_paths_for_videos_and_spreadsheets_and_cleans_them_up() {
        let attachments = [
            attachment("clip.webm", "video/webm", "dmlkZW8tYnl0ZXM="),
            attachment("budget.xlsx", XLSX, "c2hlZXQtYnl0ZXM="),
        ];
        let materialized = materialize_claude_disk_attachments("Inspect these", &attachments)
            .await
            .unwrap();
        let paths: Vec<_> = materialized.file_paths().collect();
        assert_eq!(paths.len(), 2);
        assert!(paths[0].ends_with("clip.webm"));
        assert!(paths[1].ends_with("budget.xlsx"));
        assert!(
            materialized
                .command
                .contains("Attached files are available on disk:")
        );
        assert!(materialized.command.contains(paths[1]));
        assert_eq!(fs::read(paths[0]).await.unwrap(), b"video-bytes");
        assert_eq!(fs::read(paths[1]).await.unwrap(), b"sheet-bytes");
        materialized.cleanup().await;
        for path in paths {
            assert!(!fs::try_exists(path).await.unwrap());
        }
    }

    #[tokio::test]
    async fn leaves_inline_image_pdf_and_text_attachments_in_the_prompt() {
        let attachments = [
            attachment("notes.txt", "text/plain", "bm90ZXM="),
            attachment("table.csv", "text/csv", "YSxi"),
            attachment("spec.pdf", "application/pdf", "cGRm"),
            attachment("shot.png", "image/png", "cG5n"),
        ];
        let materialized = materialize_claude_disk_attachments("Read this", &attachments)
            .await
            .unwrap();
        assert_eq!(materialized.command, "Read this");
        assert_eq!(materialized.file_paths().count(), 0);
        let names: Vec<_> = materialized
            .inline_attachments
            .iter()
            .map(|attachment| attachment.name.unwrap())
            .collect();
        assert_eq!(names, ["notes.txt", "table.csv", "spec.pdf", "shot.png"]);
        materialized.cleanup().await;
    }

    #[tokio::test]
    async fn writes_text_too_long_to_inline_to_disk_instead_of_truncating_it() {
        let attachments = [attachment("large.csv", "text/csv", &"YSxi".repeat(53_334))];
        let materialized = materialize_claude_disk_attachments("Analyze", &attachments)
            .await
            .unwrap();
        assert!(materialized.inline_attachments.is_empty());
        let path = materialized.file_paths().next().unwrap();
        assert!(path.ends_with("large.csv"));
        assert_eq!(fs::read(path).await.unwrap(), b"a,b".repeat(53_334));
        materialized.cleanup().await;
        assert!(!fs::try_exists(path).await.unwrap());
    }

    #[tokio::test]
    async fn matches_the_original_command_and_file_bytes_for_mixed_attachments() {
        let command = "Inspect these";
        let attachments = [
            attachment("video.webm", "video/webm", "dmlkZW8tYnl0ZXM="),
            attachment("table.csv", "text/csv", "YSxi"),
            attachment("quoted \"name\".xlsx", XLSX, "c2hlZXQtYnl0ZXM="),
            attachment("spec.pdf", "application/pdf", "cGRm"),
            attachment("skipped.bin", "application/octet-stream", ""),
        ];
        let directory = tempfile::tempdir().unwrap();
        let input = directory.path().join("attachments.json");
        fs::write(
            &input,
            serde_json::to_vec(&json!({"command":command, "attachments":attachments})).unwrap(),
        )
        .await
        .unwrap();
        let original = Command::new("bun")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/oracles/disk-attachments.ts"
            ))
            .arg(input)
            .output()
            .await
            .unwrap();
        assert!(
            original.status.success(),
            "{}",
            String::from_utf8_lossy(&original.stderr)
        );

        let result = materialize_claude_disk_attachments(command, &attachments)
            .await
            .unwrap();
        let mut command = result.command.clone();
        let mut files = Vec::new();
        for path in result.file_paths() {
            let name = basename(path);
            command = command.replacen(path, &format!("<temp>/{name}"), 1);
            files.push(json!({"name":name, "content":fs::read_to_string(path).await.unwrap()}));
        }
        let inline_names: Vec<_> = result
            .inline_attachments
            .iter()
            .map(|input| input.name)
            .collect();
        result.cleanup().await;
        let actual = serde_json::to_vec(
            &json!({"command":command, "inlineNames":inline_names, "files":files}),
        )
        .unwrap();
        assert_eq!(
            String::from_utf8(actual).unwrap(),
            String::from_utf8(original.stdout).unwrap()
        );
    }
}
