//! Ports `server/remote/client/remote-files.ts`.

use std::rc::Rc;

use async_trait::async_trait;
use base64::{Engine, engine::general_purpose::STANDARD};
use garcon_base::domain_error::DomainError;
use garcon_contract::{
    error_codes::ErrorCode,
    file_contracts::{
        CanonicalFileIdentity, DirectoryEntry, FileRevisionResponse, FileSaveConflictResolution,
        FileTreeResponse, MAX_FILE_SAVE_BYTES, SaveTextResponse, is_file_revision,
        parse_directory_entry, parse_save_text_response,
    },
};
use garcon_interface::{
    files::{
        ExecutionDirectoryCreation, ExecutionDirectoryRequest, ExecutionFileEntry,
        ExecutionFileList, ExecutionFileListRequest, ExecutionFileRead, ExecutionFileSave,
        ExecutionFileTarget, ExecutionFilesService,
    },
    resources::{ExecutorCallOptions, ExecutorResult},
};
use garcon_js::json::Opaque;
use garcon_link::file_protocol::{decode_file_data, invalid_file_data};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;

use super::{
    sessions::{HeldCallOptions, RemoteSessions},
    wire::{decode, encode, unknown_outcome},
};

const FILE_TRANSFER_TIMEOUT_MS: f64 = 30_000.0;

pub(super) struct RemoteFilesService(pub Rc<RemoteSessions>);

impl RemoteFilesService {
    async fn call<T: DeserializeOwned>(
        &self,
        method: &str,
        request: impl Serialize,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<T> {
        let result = self
            .0
            .call("", method, encode(request)?, options.into())
            .await?;
        decode(result.as_ref())
    }
}

#[async_trait(?Send)]
impl ExecutionFilesService for RemoteFilesService {
    async fn tree(
        &self,
        request: ExecutionDirectoryRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<FileTreeResponse> {
        self.call("files.tree", request, options).await
    }

    async fn browse(
        &self,
        request: ExecutionDirectoryRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Vec<ExecutionFileEntry>> {
        self.call("files.browse", request, options).await
    }

    async fn list(
        &self,
        request: ExecutionFileListRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<ExecutionFileList> {
        self.call("files.list", request, options).await
    }

    async fn identity(
        &self,
        request: ExecutionFileTarget,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<CanonicalFileIdentity> {
        self.call("files.identity", request, options).await
    }

    async fn revision(
        &self,
        request: ExecutionFileTarget,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<FileRevisionResponse> {
        self.call("files.revision", request, options).await
    }

    async fn read(
        &self,
        request: ExecutionFileTarget,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<ExecutionFileRead> {
        let reply = self
            .0
            .call(
                "",
                "files.read",
                encode(request)?,
                transfer_options(options),
            )
            .await?;
        Ok(decode_file_read(reply.as_deref().unwrap_or(&Value::Null))?)
    }

    async fn save(
        &self,
        request: ExecutionFileSave,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<SaveTextResponse> {
        let result = self
            .0
            .call(
                "",
                "files.save",
                save_request(request)?,
                transfer_options(options),
            )
            .await;
        let reply = file_mutation(result, unknown_save)?;
        parse_save_text_response(&reply).ok_or_else(|| unknown_save().into())
    }

    async fn create_directory(
        &self,
        request: ExecutionDirectoryCreation,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<DirectoryEntry> {
        let result = self
            .0
            .call(
                "",
                "files.createDirectory",
                encode(request)?,
                transfer_options(options),
            )
            .await;
        let reply = file_mutation(result, unknown_creation)?;
        parse_directory_entry(&reply).ok_or_else(|| unknown_creation().into())
    }
}

fn transfer_options(options: Option<ExecutorCallOptions>) -> HeldCallOptions {
    let mut options = options.unwrap_or_default();
    options.timeout_ms.get_or_insert(FILE_TRANSFER_TIMEOUT_MS);
    Some(options).into()
}

fn decode_file_read(value: &Value) -> Result<ExecutionFileRead, DomainError> {
    if !is_file_revision(&value["revision"]) {
        return Err(invalid_file_data());
    }
    let path = value["path"].as_str().ok_or_else(invalid_file_data)?;
    let revision = value["revision"].as_str().ok_or_else(invalid_file_data)?;
    Ok(ExecutionFileRead {
        bytes: decode_file_data(&value["data"])?,
        path: path.to_owned(),
        revision: revision.to_owned(),
    })
}

fn save_request(request: ExecutionFileSave) -> ExecutorResult<Opaque> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Save<'a> {
        expected_revision: &'a str,
        conflict_resolution: FileSaveConflictResolution,
        project_path: &'a str,
        file_path: &'a str,
        data: String,
    }
    let save = request.request;
    let revision = Value::String(save.expected_revision);
    let expected_revision = revision
        .as_str()
        .filter(|_| is_file_revision(&revision))
        .ok_or_else(|| {
            DomainError::new_validation(
                "Content, expectedRevision, and conflictResolution are required",
            )
        })?;
    if save.content.len() > MAX_FILE_SAVE_BYTES {
        return Err(DomainError::new(
            ErrorCode::FILE_TOO_LARGE,
            "File exceeds the 4 MiB text save limit",
            413,
            false,
        )
        .into());
    }
    encode(Save {
        expected_revision,
        conflict_resolution: save.conflict_resolution,
        project_path: &request.target.project_path,
        file_path: &request.target.file_path,
        data: STANDARD.encode(save.content),
    })
}

fn file_mutation(
    reply: ExecutorResult<Option<Opaque>>,
    unknown: fn() -> DomainError,
) -> ExecutorResult<Opaque> {
    match reply {
        Ok(Some(reply)) => Ok(reply),
        Ok(None) => Err(unknown().into()),
        Err(error) if unknown_outcome(error.as_ref()) => Err(unknown().into()),
        Err(error) => Err(error),
    }
}

fn unknown_creation() -> DomainError {
    DomainError::new(
        ErrorCode::FILE_CREATE_OUTCOME_UNKNOWN,
        "Directory creation could not be confirmed. Refresh the directory before trying again.",
        503,
        false,
    )
}

fn unknown_save() -> DomainError {
    DomainError::new(
        ErrorCode::FILE_SAVE_OUTCOME_UNKNOWN,
        "Save could not be confirmed. Reload the file before saving again.",
        503,
        false,
    )
}
