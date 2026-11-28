use std::cell::Cell;
use std::rc::Rc;
use std::time::Duration;

use garcon_base::domain_error::DomainError;
use garcon_base::errors::{ErrorInput, diagnostic_error_code};
use garcon_contract::error_codes::ErrorCode;
use garcon_contract::file_contracts::{
    FileSaveConflictResolution, MAX_FILE_REVISION_LENGTH, MAX_FILE_SAVE_BYTES, SaveTextRequest,
};
use garcon_interface::files::{
    ExecutionDirectoryCreation, ExecutionDirectoryRequest, ExecutionFileSave, ExecutionFileTarget,
    ExecutionFilesService,
};
use garcon_interface::resources::ExecutorCallOptions;
use tempfile::TempDir;
use tokio::sync::{Notify, Semaphore};
use tokio::task::LocalSet;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use super::service::{FilesService, FilesServiceOptions};
use crate::git::operation_context::is_git_cancellation;

struct Fixture {
    _temp: TempDir,
    target: ExecutionFileTarget,
}

#[tokio::test]
async fn unsupported_directory_creation_wins_before_validating_the_request() {
    let fixture = Fixture::new().await;
    let service = fixture.service(FilesServiceOptions {
        descriptor_paths: Some(None),
        ..Default::default()
    });
    assert!(!service.can_create_directories());
    let result = service
        .create_directory(
            ExecutionDirectoryCreation {
                parent_path: "missing".to_owned(),
                name: "..".to_owned(),
            },
            None,
        )
        .await
        .unwrap_err();
    let error = result.downcast_ref::<DomainError>().unwrap();
    assert_eq!(error.code, ErrorCode::OPERATION_UNSUPPORTED);
    assert_eq!(error.status, 501);
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn directory_creation_never_replaces_escapes_or_nests() {
    let fixture = Fixture::new().await;
    let root = &fixture.target.project_path;
    let service = fixture.service(FilesServiceOptions::default());
    let call = |name: &str| {
        service.create_directory(
            ExecutionDirectoryCreation {
                parent_path: root.clone(),
                name: name.to_owned(),
            },
            None,
        )
    };
    for name in [
        "",
        "..",
        "../escape",
        "nested/child",
        "nested\\child",
        "a\0b",
    ] {
        let failure = call(name).await.unwrap_err();
        assert_eq!(
            failure.downcast_ref::<DomainError>().unwrap().code,
            ErrorCode::VALIDATION_FAILED
        );
    }
    assert_eq!(
        tokio::fs::read(format!("{root}/file.txt")).await.unwrap(),
        b"initial"
    );
    assert!(!std::path::Path::new(&format!("{root}/nested")).exists());
    let longest = "x".repeat(255);
    let child = call(&longest).await.unwrap();
    assert_eq!(child.name, longest);
    assert!(std::path::Path::new(&child.path).is_dir());
}

impl Fixture {
    async fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        // Temp paths may contain symlink components on some platforms.
        let root = garcon_base::path_boundary::realpath(temp.path())
            .await
            .unwrap();
        tokio::fs::write(root.join("file.txt"), "initial")
            .await
            .unwrap();
        Self {
            _temp: temp,
            target: ExecutionFileTarget {
                project_path: root.to_str().unwrap().to_owned(),
                file_path: "file.txt".to_owned(),
            },
        }
    }

    fn service(&self, options: FilesServiceOptions) -> FilesService {
        FilesService::new(FilesServiceOptions {
            executor_id: "synthetic".to_owned(),
            project_base_path: self.target.project_path.clone(),
            ..options
        })
    }

    fn save(&self, name: &str, content: &str, revision: &str) -> ExecutionFileSave {
        ExecutionFileSave {
            target: ExecutionFileTarget {
                file_path: name.to_owned(),
                ..self.target.clone()
            },
            request: SaveTextRequest {
                content: content.to_owned(),
                expected_revision: revision.to_owned(),
                conflict_resolution: FileSaveConflictResolution::Reject,
            },
        }
    }
}

#[tokio::test]
async fn two_hard_links_share_one_save_revision_check() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new().await;
            let root = std::path::Path::new(&fixture.target.project_path);
            tokio::fs::hard_link(root.join("file.txt"), root.join("alias.txt"))
                .await
                .unwrap();
            let service = fixture.service(FilesServiceOptions::default());
            let first = service.read(fixture.target.clone(), None).await.unwrap();
            let (file, alias) = tokio::join!(
                service.save(fixture.save("file.txt", "file", &first.revision), None),
                service.save(fixture.save("alias.txt", "alias", &first.revision), None),
            );
            let error = match (file, alias) {
                (Ok(_), Err(error)) | (Err(error), Ok(_)) => error,
                result => panic!("expected exactly one write: {result:?}"),
            };
            assert_eq!(
                error.downcast_ref::<DomainError>().unwrap().code,
                ErrorCode::FILE_REVISION_CONFLICT
            );
        })
        .await;
}

#[tokio::test]
async fn content_admission_survives_lost_replies_and_does_not_gate_metadata() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new().await;
            let ordinary = fixture.service(FilesServiceOptions::default());
            let revision = ordinary
                .read(fixture.target.clone(), None)
                .await
                .unwrap()
                .revision;
            let entered = Rc::new(Semaphore::new(0));
            let release = Rc::new(Notify::new());
            let first = fixture.service(FilesServiceOptions {
                resolve_save_target: Some(Rc::new({
                    let entered = entered.clone();
                    let release = release.clone();
                    let resolves = Cell::new(0);
                    move |root, input| {
                        resolves.set(resolves.get() + 1);
                        let hold = resolves.get() <= 8;
                        let entered = entered.clone();
                        let release = release.clone();
                        Box::pin(async move {
                            if hold {
                                let released = release.notified();
                                entered.add_permits(1);
                                released.await;
                            }
                            garcon_base::path_boundary::resolve_real_within_base(root, input).await
                        })
                    }
                })),
                ..FilesServiceOptions::default()
            });
            let mut replies = (0..8)
                .map(|_| {
                    let service = first.clone();
                    let request = fixture.save("file.txt", "first", &revision);
                    tokio::task::spawn_local(async move { service.save(request, None).await })
                })
                .collect::<Vec<_>>();
            timeout(Duration::from_secs(3), entered.acquire_many(8))
                .await
                .unwrap()
                .unwrap()
                .forget();
            let lost = replies.pop().unwrap();
            lost.abort();
            assert!(lost.await.unwrap_err().is_cancelled());
            let busy = ordinary
                .read(fixture.target.clone(), None)
                .await
                .unwrap_err();
            assert_eq!(
                busy.downcast_ref::<DomainError>().unwrap().code,
                ErrorCode::FILE_SERVICE_BUSY
            );
            let busy = ordinary
                .save(fixture.save("file.txt", "extra", &revision), None)
                .await
                .unwrap_err();
            assert_eq!(
                busy.downcast_ref::<DomainError>().unwrap().code,
                ErrorCode::FILE_SERVICE_BUSY
            );
            let identity = ordinary
                .identity(fixture.target.clone(), None)
                .await
                .unwrap();
            assert_eq!(identity.normalized_relative_path, "file.txt");
            let tree = ordinary
                .tree(
                    ExecutionDirectoryRequest {
                        directory_path: None,
                    },
                    None,
                )
                .await
                .unwrap();
            assert_eq!(tree.entries.len(), 1);
            release.notify_waiters();
            let mut failures = 0;
            for reply in replies {
                if let Err(error) = reply.await.unwrap() {
                    assert_eq!(
                        error.downcast_ref::<DomainError>().unwrap().code,
                        ErrorCode::FILE_REVISION_CONFLICT
                    );
                    failures += 1;
                }
            }
            assert!(failures >= 6);
            assert_eq!(
                ordinary
                    .read(fixture.target.clone(), None)
                    .await
                    .unwrap()
                    .bytes,
                b"first"
            );
        })
        .await;
}

#[tokio::test]
async fn replacement_service_cannot_pass_a_cancelled_dispatched_save() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new().await;
            let replacement = fixture.service(FilesServiceOptions::default());
            let revision = replacement
                .read(fixture.target.clone(), None)
                .await
                .unwrap()
                .revision;
            let first_request = fixture.save("file.txt", "retired", &revision);
            let second_request = fixture.save("file.txt", "replacement", &revision);
            let entered = Rc::new(Notify::new());
            let release = Rc::new(Notify::new());
            let first = fixture.service(FilesServiceOptions {
                before_write: Some(Rc::new({
                    let entered = entered.clone();
                    let release = release.clone();
                    move || {
                        let entered = entered.clone();
                        let release = release.clone();
                        Box::pin(async move {
                            entered.notify_one();
                            release.notified().await;
                        })
                    }
                })),
                ..FilesServiceOptions::default()
            });
            let cancel = CancellationToken::new();
            let options = ExecutorCallOptions {
                signal: Some(cancel.clone()),
                ..Default::default()
            };
            let first =
                tokio::task::spawn_local(
                    async move { first.save(first_request, Some(options)).await },
                );
            timeout(Duration::from_secs(3), entered.notified())
                .await
                .unwrap();
            cancel.cancel();
            first.abort();
            assert!(first.await.unwrap_err().is_cancelled());

            let second = tokio::task::spawn_local({
                let replacement = replacement.clone();
                async move { replacement.save(second_request, None).await }
            });
            assert!(
                timeout(Duration::from_millis(40), async {
                    while !second.is_finished() {
                        tokio::task::yield_now().await;
                    }
                })
                .await
                .is_err()
            );
            release.notify_one();
            let error = second.await.unwrap().unwrap_err();
            assert_eq!(
                error.downcast_ref::<DomainError>().unwrap().code,
                ErrorCode::FILE_REVISION_CONFLICT
            );
            assert_eq!(
                replacement
                    .read(fixture.target.clone(), None)
                    .await
                    .unwrap()
                    .bytes,
                b"retired"
            );
        })
        .await;
}

#[tokio::test]
async fn invalid_revision_oversized_content_and_preabort_leave_file_unchanged() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new().await;
            let service = fixture.service(FilesServiceOptions::default());
            let snapshot = service.read(fixture.target.clone(), None).await.unwrap();
            let invalid = format!("v1:{}", "a".repeat(MAX_FILE_REVISION_LENGTH));
            let mut request = fixture.save("file.txt", "updated", &invalid);
            request.request.conflict_resolution = FileSaveConflictResolution::Overwrite;
            let error = service.save(request, None).await.unwrap_err();
            assert_eq!(
                error.downcast_ref::<DomainError>().unwrap().code,
                ErrorCode::VALIDATION_FAILED
            );

            let mut request = fixture.save("file.txt", "", &snapshot.revision);
            request.request.content = "x".repeat(MAX_FILE_SAVE_BYTES + 1);
            request.request.conflict_resolution = FileSaveConflictResolution::Overwrite;
            let error = service.save(request, None).await.unwrap_err();
            assert_eq!(
                error.downcast_ref::<DomainError>().unwrap().code,
                ErrorCode::FILE_TOO_LARGE
            );

            let cancel = CancellationToken::new();
            cancel.cancel();
            let options = ExecutorCallOptions {
                signal: Some(cancel),
                ..Default::default()
            };
            let error = service
                .read(fixture.target.clone(), Some(options))
                .await
                .unwrap_err();
            assert_eq!(
                diagnostic_error_code(ErrorInput::Error(error.as_ref())),
                "AbortError"
            );
            assert!(is_git_cancellation(error.as_ref()));
            assert_eq!(error.to_string(), "The operation was aborted.");
            let actual = service.read(fixture.target, None).await.unwrap();
            assert_eq!(actual.bytes, snapshot.bytes);
            assert_eq!(actual.revision, snapshot.revision);
        })
        .await;
}
