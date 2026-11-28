//! Ports `server/runtime/files/service.ts`.

use std::cell::Cell;
use std::future::Future;
use std::rc::Rc;

use async_trait::async_trait;
use futures::future::LocalBoxFuture;
use garcon_base::domain_error::DomainError;
use garcon_base::executor_path::{to_executor_path, to_native_path};
use garcon_base::keyed_lock::KeyedLock;
use garcon_base::path_boundary::{
    ProjectPathError, assert_real_within_base, resolve_real_within_base,
};
use garcon_contract::error_codes::ErrorCode;
use garcon_contract::file_contracts::{
    CanonicalFileIdentity, DirectoryEntry, DirectoryNameProblem, FileRevisionResponse,
    FileSaveConflictResolution, FileTreeDirectory, FileTreeEntry, FileTreeEntryType,
    FileTreeHomeDirectory, FileTreeResponse, MAX_FILE_SAVE_BYTES, SaveTextResponse,
    directory_name_problem, is_file_revision,
};
use garcon_interface::files::{
    ExecutionDirectoryCreation, ExecutionDirectoryRequest, ExecutionFileEntry, ExecutionFileList,
    ExecutionFileListRequest, ExecutionFileRead, ExecutionFileSave, ExecutionFileTarget,
    ExecutionFilesService,
};
use garcon_interface::resources::{ExecutorCallOptions, ExecutorResult};
use garcon_js::{path::native, utf16};
use serde_json::Value;
use tokio::fs;
use tokio_util::sync::CancellationToken;

use super::directory_creation::{
    create_child_directory, descriptor_paths_directory, directory_creation_unsupported,
};
use super::directory_reader::{
    file_breadcrumbs, list_project_files, read_directory_candidates, read_file_directory,
    relative_file_path,
};
use super::errors::{
    check_cancelled, directory_creation_error, file_operation_error, file_revision_conflict,
};
use super::file_revision::{
    VersionedReadOptions, file_too_large, get_file_lock_key, get_file_revision_or_missing,
    read_versioned_file, write_versioned_text_file,
};

pub type AssertAvailable = dyn Fn(Option<&ExecutorCallOptions>) -> ExecutorResult<()>;
pub type ResolveSaveTarget =
    dyn for<'a> Fn(&'a str, &'a str) -> LocalBoxFuture<'a, Result<String, ProjectPathError>>;
pub type ReadDirectory = dyn for<'a> Fn(
    &'a str,
    &'a str,
    Option<&'a CancellationToken>,
) -> LocalBoxFuture<'a, ExecutorResult<Vec<FileTreeEntry>>>;

#[derive(Default)]
pub struct FilesServiceOptions {
    pub executor_id: String,
    pub project_base_path: String,
    pub home_directory: Option<String>,
    pub assert_available: Option<Rc<AssertAvailable>>,
    pub resolve_save_target: Option<Rc<ResolveSaveTarget>>,
    pub read_directory: Option<Rc<ReadDirectory>>,
    /// Absent detects descriptor paths; an explicit None forces unsupported.
    pub descriptor_paths: Option<Option<String>>,
    #[cfg(test)]
    pub(super) before_write: Option<Rc<dyn Fn() -> LocalBoxFuture<'static, ()>>>,
}

const MAX_FILE_CONTENT_OPERATIONS: usize = 8;

thread_local! {
    static SAVE_LOCKS: Rc<KeyedLock> = Rc::new(KeyedLock::new());
    static ACTIVE_CONTENT_OPERATIONS: Cell<usize> = const { Cell::new(0) };
}

struct ContentPermit;

impl ContentPermit {
    fn acquire() -> Result<Self, DomainError> {
        ACTIVE_CONTENT_OPERATIONS.with(|active| {
            if active.get() >= MAX_FILE_CONTENT_OPERATIONS {
                return Err(DomainError::new(
                    ErrorCode::FILE_SERVICE_BUSY,
                    "Too many active file reads or saves",
                    503,
                    true,
                ));
            }
            active.set(active.get() + 1);
            Ok(Self)
        })
    }
}

impl Drop for ContentPermit {
    fn drop(&mut self) {
        ACTIVE_CONTENT_OPERATIONS.with(|active| active.set(active.get() - 1));
    }
}

#[derive(Clone)]
pub struct FilesService {
    options: Rc<FilesServiceOptions>,
    descriptor_paths: Option<String>,
}

impl FilesService {
    pub fn new(options: FilesServiceOptions) -> Self {
        let descriptor_paths = options
            .descriptor_paths
            .clone()
            .unwrap_or_else(|| descriptor_paths_directory().map(str::to_owned));
        Self {
            options: Rc::new(options),
            descriptor_paths,
        }
    }

    pub fn can_create_directories(&self) -> bool {
        self.descriptor_paths.is_some()
    }

    async fn directory(&self, input: Option<&str>) -> ExecutorResult<(String, String)> {
        let root = self.root(&self.options.project_base_path).await?;
        let input = input.filter(|path| !path.is_empty()).unwrap_or(&root);
        let directory = assert_real_within_base(&root, &to_native_path(input, None)).await?;
        if !fs::metadata(&directory).await?.is_dir() {
            return Err(DomainError::new(
                ErrorCode::FILE_DIRECTORY_REQUIRED,
                "File tree path must identify a directory",
                400,
                false,
            )
            .into());
        }
        Ok((root, directory))
    }

    async fn root(&self, input: &str) -> ExecutorResult<String> {
        if !is_path_input(input) {
            return Err(DomainError::new_validation("Invalid project path").into());
        }
        Ok(assert_real_within_base(
            &to_native_path(&self.options.project_base_path, None),
            &to_native_path(input, None),
        )
        .await?)
    }

    async fn target(&self, request: &ExecutionFileTarget) -> ExecutorResult<String> {
        validate_target(request)?;
        let root = self.root(&request.project_path).await?;
        Ok(resolve_real_within_base(&root, &to_native_path(&request.file_path, None)).await?)
    }

    async fn resolve_save_target(&self, root: &str, input: &str) -> ExecutorResult<String> {
        Ok(match &self.options.resolve_save_target {
            Some(resolve) => resolve(root, input).await?,
            None => resolve_real_within_base(root, input).await?,
        })
    }

    fn available(&self, options: Option<&ExecutorCallOptions>) -> ExecutorResult<()> {
        check_cancelled(options.and_then(|options| options.signal.as_ref()))?;
        if let Some(check) = &self.options.assert_available {
            check(options)?;
        }
        Ok(())
    }

    async fn run<T>(
        &self,
        options: Option<&ExecutorCallOptions>,
        operation: impl Future<Output = ExecutorResult<T>>,
    ) -> ExecutorResult<T> {
        self.available(options)?;
        operation.await.map_err(file_operation_error)
    }

    async fn run_content<T: 'static, F: Future<Output = ExecutorResult<T>> + 'static>(
        &self,
        options: Option<&ExecutorCallOptions>,
        operation: impl FnOnce(Self) -> F,
    ) -> ExecutorResult<T> {
        self.available(options)?;
        let permit = ContentPermit::acquire()?;
        let operation = operation(self.clone());
        // A dropped reply cannot release admission or a save lock mid-operation.
        tokio::task::spawn_local(async move {
            let _permit = permit;
            operation.await.map_err(file_operation_error)
        })
        .await?
    }

    async fn tree_home(&self, root: &str) -> Option<FileTreeHomeDirectory> {
        let home = match self.options.home_directory.as_deref() {
            Some(home) => std::borrow::Cow::Borrowed(home),
            None => std::borrow::Cow::Owned(std::env::home_dir()?.to_string_lossy().into_owned()),
        };
        let home = assert_real_within_base(root, &home).await.ok()?;
        fs::metadata(&home)
            .await
            .ok()?
            .is_dir()
            .then(|| FileTreeHomeDirectory {
                path: to_executor_path(&home, None),
                breadcrumbs: file_breadcrumbs(root, &home),
            })
    }
}

fn is_path_input(value: &str) -> bool {
    !value.is_empty() && utf16::len(value) <= 4096 && !value.contains('\0')
}

fn validate_target(target: &ExecutionFileTarget) -> Result<(), DomainError> {
    if !is_path_input(&target.file_path) {
        Err(DomainError::new_validation("Invalid file path"))
    } else {
        Ok(())
    }
}

fn directory_name_message(problem: DirectoryNameProblem) -> &'static str {
    match problem {
        DirectoryNameProblem::Empty => "A directory name is required",
        DirectoryNameProblem::Reserved => "Directory name is reserved",
        DirectoryNameProblem::InvalidCharacter => {
            "Directory name cannot contain path separators or control characters"
        }
        DirectoryNameProblem::TooLong => "Directory name is too long",
    }
}

#[async_trait(?Send)]
impl ExecutionFilesService for FilesService {
    async fn tree(
        &self,
        request: ExecutionDirectoryRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<FileTreeResponse> {
        self.run(options.as_ref(), async {
            let (root, directory) = self.directory(request.directory_path.as_deref()).await?;
            let home_directory = self.tree_home(&root).await;
            let signal = options.as_ref().and_then(|options| options.signal.as_ref());
            let entries = match &self.options.read_directory {
                Some(read) => read(&root, &directory, signal).await?,
                None => read_file_directory(&root, &directory, signal).await?,
            };
            Ok(FileTreeResponse {
                file_root_path: to_executor_path(&root, None),
                home_directory,
                directory: FileTreeDirectory {
                    path: to_executor_path(&directory, None),
                    relative_path: relative_file_path(&root, &directory),
                    parent_path: (directory != root)
                        .then(|| to_executor_path(&native::dirname(&directory), None)),
                    breadcrumbs: file_breadcrumbs(&root, &directory),
                },
                entries,
            })
        })
        .await
    }

    async fn browse(
        &self,
        request: ExecutionDirectoryRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Vec<ExecutionFileEntry>> {
        self.run(options.as_ref(), async {
            let (root, directory) = self.directory(request.directory_path.as_deref()).await?;
            read_directory_candidates(
                &root,
                &directory,
                options.as_ref().and_then(|options| options.signal.as_ref()),
            )
            .await
        })
        .await
    }

    async fn list(
        &self,
        request: ExecutionFileListRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<ExecutionFileList> {
        self.run(options.as_ref(), async {
            let root = self.root(&request.project_path).await?;
            list_project_files(
                &root,
                options.as_ref().and_then(|options| options.signal.as_ref()),
            )
            .await
        })
        .await
    }

    async fn identity(
        &self,
        request: ExecutionFileTarget,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<CanonicalFileIdentity> {
        self.run(options.as_ref(), async {
            validate_target(&request)?;
            let input = to_native_path(&request.file_path, None);
            let normalized = native::normalize(&input);
            if input.is_empty()
                || native::is_absolute(&input)
                || matches!(normalized.as_str(), "." | "..")
                || normalized
                    .strip_prefix("..")
                    .is_some_and(|suffix| suffix.starts_with(native::SEP))
            {
                return Err(
                    DomainError::new_validation("A valid relative file path is required").into(),
                );
            }
            let root = self.root(&request.project_path).await?;
            let target = resolve_real_within_base(&root, &input).await?;
            if !fs::metadata(&target).await?.is_file() {
                return Err(DomainError::new(
                    ErrorCode::FILE_PATH_MUST_IDENTIFY_FILE,
                    "File path must identify a file",
                    400,
                    false,
                )
                .into());
            }
            Ok(CanonicalFileIdentity {
                executor_id: self.options.executor_id.clone(),
                canonical_file_root_path: to_executor_path(&root, None),
                normalized_relative_path: relative_file_path(&root, &target),
            })
        })
        .await
    }

    async fn revision(
        &self,
        request: ExecutionFileTarget,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<FileRevisionResponse> {
        self.run(options.as_ref(), async {
            let target = self.target(&request).await?;
            Ok(match get_file_revision_or_missing(&target).await? {
                Some(revision) => FileRevisionResponse::Ready { revision },
                None => FileRevisionResponse::Missing,
            })
        })
        .await
    }

    async fn read(
        &self,
        request: ExecutionFileTarget,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<ExecutionFileRead> {
        self.run_content(options.as_ref(), |this| async move {
            let target = this.target(&request).await?;
            let result = read_versioned_file(&target, VersionedReadOptions::default()).await?;
            Ok(ExecutionFileRead {
                bytes: result.bytes,
                path: to_executor_path(&target, None),
                revision: result.revision,
            })
        })
        .await
    }

    async fn save(
        &self,
        request: ExecutionFileSave,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<SaveTextResponse> {
        let later = options.clone();
        self.run_content(options.as_ref(), |this| async move {
            let ExecutionFileSave {
                target: request_target,
                request,
            } = request;
            validate_target(&request_target)?;
            if !is_file_revision(&Value::String(request.expected_revision.clone())) {
                return Err(DomainError::new_validation(
                    "Content, expectedRevision, and conflictResolution are required",
                )
                .into());
            }
            if request.content.len() > MAX_FILE_SAVE_BYTES {
                return Err(file_too_large(MAX_FILE_SAVE_BYTES).into());
            }
            let root = this.root(&request_target.project_path).await?;
            let input = to_native_path(&request_target.file_path, None);
            let target = this.resolve_save_target(&root, &input).await?;
            let key = get_file_lock_key(&target).await?;
            let locks = SAVE_LOCKS.with(Rc::clone);
            locks
                .run_exclusive(
                    &key,
                    || async {
                        this.available(later.as_ref())?;
                        let locked = this.resolve_save_target(&root, &input).await?;
                        if locked != target || get_file_lock_key(&locked).await? != key {
                            return Err(file_revision_conflict().into());
                        }
                        let current = get_file_revision_or_missing(&target).await?;
                        if request.conflict_resolution == FileSaveConflictResolution::Reject
                            && current.as_deref() != Some(request.expected_revision.as_str())
                        {
                            return Err(file_revision_conflict().into());
                        }
                        this.available(later.as_ref())?;
                        #[cfg(test)]
                        if let Some(before_write) = &this.options.before_write {
                            before_write().await;
                        }
                        let revision = write_versioned_text_file(&target, &request.content).await?;
                        Ok(SaveTextResponse {
                            success: true,
                            path: to_executor_path(&target, None),
                            message: "File saved successfully".to_owned(),
                            revision,
                        })
                    },
                    None,
                )
                .await?
        })
        .await
    }

    async fn create_directory(
        &self,
        request: ExecutionDirectoryCreation,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<DirectoryEntry> {
        self.run(options.as_ref(), async {
            let descriptor_paths = self
                .descriptor_paths
                .as_deref()
                .ok_or_else(directory_creation_unsupported)?;
            if let Some(problem) = directory_name_problem(&request.name) {
                return Err(DomainError::new_validation(directory_name_message(problem)).into());
            }
            if !is_path_input(&request.parent_path) {
                return Err(DomainError::new_validation("Invalid directory path").into());
            }
            let (_, directory) = self.directory(Some(&request.parent_path)).await?;
            self.available(options.as_ref())?;
            let target = create_child_directory(descriptor_paths, &directory, &request.name)
                .await
                .map_err(directory_creation_error)?;
            Ok(DirectoryEntry {
                name: request.name,
                path: to_executor_path(&target, None),
                r#type: FileTreeEntryType::Directory,
            })
        })
        .await
    }
}
