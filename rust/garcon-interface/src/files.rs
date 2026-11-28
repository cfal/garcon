//! Ports `server-agents/interface/src/contracts/files.ts`.

use async_trait::async_trait;
use garcon_contract::file_contracts::{
    CanonicalFileIdentity, DirectoryEntry, FileRevision, FileRevisionResponse, FileTreeEntryType,
    FileTreeResponse, SaveTextRequest, SaveTextResponse,
};
use serde::{Deserialize, Serialize};

use crate::resources::{ExecutorCallOptions, ExecutorResult};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionFileTarget {
    pub project_path: String,
    pub file_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionFileEntry {
    pub name: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relative_path: Option<String>,
    pub r#type: FileTreeEntryType,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionDirectoryCreation {
    pub parent_path: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionFileRead {
    pub bytes: Vec<u8>,
    pub path: String,
    pub revision: FileRevision,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionDirectoryRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub directory_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionFileListRequest {
    pub project_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecutionFileList {
    pub files: Vec<ExecutionFileEntry>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionFileSave {
    pub target: ExecutionFileTarget,
    pub request: SaveTextRequest,
}

#[async_trait(?Send)]
pub trait ExecutionFilesService {
    async fn tree(
        &self,
        request: ExecutionDirectoryRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<FileTreeResponse>;
    async fn browse(
        &self,
        request: ExecutionDirectoryRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Vec<ExecutionFileEntry>>;
    async fn list(
        &self,
        request: ExecutionFileListRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<ExecutionFileList>;
    async fn identity(
        &self,
        request: ExecutionFileTarget,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<CanonicalFileIdentity>;
    async fn revision(
        &self,
        request: ExecutionFileTarget,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<FileRevisionResponse>;
    async fn read(
        &self,
        request: ExecutionFileTarget,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<ExecutionFileRead>;
    async fn save(
        &self,
        request: ExecutionFileSave,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<SaveTextResponse>;
    async fn create_directory(
        &self,
        request: ExecutionDirectoryCreation,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<DirectoryEntry>;
}
