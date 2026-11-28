use std::ffi::OsString;
use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::{Engine, engine::general_purpose::STANDARD};
use garcon_base::domain_error::DomainError;
use garcon_base::path_boundary::{ProjectBoundaryError, assert_real_within_base};
use garcon_cases::{CaseError, replay, text};
use garcon_contract::file_contracts::{FileSaveConflictResolution, SaveTextRequest};
use garcon_interface::execution_runtime::{
    ExecutionProjectInspectRequest, ExecutionProjectService, ResolveFileMentionsRequest,
};
#[cfg(target_os = "linux")]
use garcon_interface::files::ExecutionDirectoryCreation;
use garcon_interface::files::{
    ExecutionDirectoryRequest, ExecutionFileListRequest, ExecutionFileSave, ExecutionFileTarget,
    ExecutionFilesService,
};
use garcon_interface::resources::ExecutorResult;
use garcon_js::json::from_slice;
use serde::Serialize;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::process::Command;
use tokio::task::LocalSet;

use crate::projects::project_directory_service::inspect_project_directory;
use crate::projects::project_service::ProjectService;

use super::directory_creation::directory_creation_unsupported;
use super::directory_reader::{file_breadcrumbs, relative_file_path};
use super::errors::{directory_creation_error, file_operation_error, file_revision_conflict};
use super::file_revision::{RevisionStat, revision_from_stat};
use super::service::{FilesService, FilesServiceOptions};

fn serialized(value: impl Serialize) -> Value {
    from_slice(&serde_json::to_vec(&value).unwrap()).unwrap()
}

fn observed(result: ExecutorResult<impl Serialize>) -> Value {
    match result {
        Ok(value) => json!({ "ok": serialized(value) }),
        Err(error) => {
            let error = error
                .downcast_ref::<DomainError>()
                .unwrap_or_else(|| panic!("non-domain error: {error}"));
            json!({ "error": domain_fields(error) })
        }
    }
}

fn domain_fields(error: &DomainError) -> Value {
    json!({ "code": error.code.as_str(), "message": error.message, "status": error.status, "retryable": error.retryable })
}

#[test]
fn recorded_filesystem_error_mappings_match() {
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/files/errors"),
        |function, args| {
            fn original_error(code: &str) -> Result<Box<dyn std::error::Error>, CaseError> {
                let raw = match code {
                    "boundary" => return Ok(Box::new(ProjectBoundaryError::default())),
                    "ENOENT" => libc::ENOENT,
                    "ENOTDIR" => libc::ENOTDIR,
                    "EACCES" => libc::EACCES,
                    "EPERM" => libc::EPERM,
                    "ELOOP" => libc::ELOOP,
                    "EEXIST" => libc::EEXIST,
                    "ENAMETOOLONG" => libc::ENAMETOOLONG,
                    "EINVAL" => libc::EINVAL,
                    "EROFS" => libc::EROFS,
                    _ => return Err(CaseError::undeliverable("unknown errno")),
                };
                Ok(Box::new(std::io::Error::from_raw_os_error(raw)))
            }

            let error: Box<dyn std::error::Error> = match function {
                "mapFileOperationError" | "mapDirectoryCreationError" => {
                    let code = text(function, args.first())?
                        .ok_or_else(|| CaseError::undeliverable("expected errno"))?;
                    let error = original_error(code)?;
                    if function == "mapFileOperationError" {
                        file_operation_error(error)
                    } else {
                        directory_creation_error(error)
                    }
                }
                "revisionConflict" => Box::new(file_revision_conflict()),
                "creationUnsupported" => Box::new(directory_creation_unsupported()),
                _ => return Err(CaseError::unhandled(function)),
            };
            let error = error.downcast_ref::<DomainError>().ok_or_else(|| {
                CaseError::undeliverable("expected the port to return a domain error")
            })?;
            Ok(domain_fields(error))
        },
    );
    assert_eq!(stats.with_wildcards, 0);
}

#[test]
fn recorded_directory_paths_and_breadcrumbs_match() {
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/files/directory-reader"
        ),
        |function, args| {
            let required = |argument| {
                text(function, argument)?
                    .ok_or_else(|| CaseError::undeliverable("missing native path string"))
            };
            let root = required(args.first())?;
            let target = required(args.get(1))?;
            match function {
                "relativeFilePath" => Ok(json!(relative_file_path(root, target))),
                "fileBreadcrumbs" => Ok(serialized(file_breadcrumbs(root, target))),
                _ => Err(CaseError::unhandled(function)),
            }
        },
    );
    assert_eq!(stats.with_wildcards, 0);
}

#[test]
fn recorded_revisions_match_exact_integer_metadata() {
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/files/file-revision"
        ),
        |function, args| {
            if function != "revisionFromStat" {
                return Err(CaseError::unhandled(function));
            }
            let value = args
                .first()
                .ok_or_else(|| CaseError::undeliverable("missing stat"))?;
            let integer = |key: &str| {
                let field = &value[key];
                field["value"]
                    .as_str()
                    .filter(|_| field["$"] == "bigint")
                    .and_then(|text| text.parse().ok())
                    .ok_or_else(|| CaseError::undeliverable(format!("expected a bigint {key}")))
            };
            Ok(json!(revision_from_stat(RevisionStat {
                dev: integer("dev")?,
                ino: integer("ino")?,
                size: integer("size")?,
                mtime_ns: integer("mtimeNs")?,
                ctime_ns: integer("ctimeNs")?,
            })))
        },
    );
    assert_eq!(stats.with_wildcards, 0);
}

fn fixture() -> TempDir {
    let parent = PathBuf::from(std::env::var_os("HOME").unwrap()).join("tmp/link");
    std::fs::create_dir_all(&parent).unwrap();
    tempfile::tempdir_in(parent).unwrap()
}

struct TreeFixture(TempDir);

impl Drop for TreeFixture {
    fn drop(&mut self) {
        let _ = std::fs::set_permissions(
            self.0.path().join("project/private"),
            std::fs::Permissions::from_mode(0o700),
        );
    }
}

fn fixture_tree() -> TreeFixture {
    use std::fs::{Permissions, create_dir, set_permissions, write};
    let temp = fixture();
    let root = temp.path();
    let project = root.join("project");
    create_dir(&project).unwrap();
    create_dir(project.join("folder")).unwrap();
    create_dir(project.join("node_modules")).unwrap();
    write(project.join("node_modules/hidden"), b"synthetic").unwrap();
    let private = project.join("private");
    create_dir(&private).unwrap();
    write(private.join("unreadable"), b"synthetic").unwrap();
    set_permissions(&private, Permissions::from_mode(0o0)).unwrap();
    for name in [
        "_x",
        "10",
        "9",
        "a",
        "A",
        "\u{e1}",
        "\u{6f22}\u{5b57}",
        "\u{1f600}",
    ] {
        write(project.join(name), name.as_bytes()).unwrap();
    }
    write(
        project.join(OsString::from_vec(vec![0xff, 0x80, b'.', b't'])),
        b"bytes",
    )
    .unwrap();
    write(project.join("stable.txt"), b"original\0bytes").unwrap();
    assert!(
        std::process::Command::new("mkfifo")
            .arg(project.join("named-pipe"))
            .status()
            .unwrap()
            .success()
    );
    write(root.join("outside.txt"), b"not in project").unwrap();
    symlink("folder", project.join("inside-link")).unwrap();
    symlink("stable.txt", project.join("alias.txt")).unwrap();
    symlink("../outside.txt", project.join("escape")).unwrap();
    symlink("loop-two", project.join("loop-one")).unwrap();
    symlink("loop-one", project.join("loop-two")).unwrap();
    TreeFixture(temp)
}

fn service(root: &str) -> FilesService {
    FilesService::new(FilesServiceOptions {
        executor_id: "synthetic".to_owned(),
        project_base_path: root.to_owned(),
        home_directory: Some(format!("{root}/project/folder")),
        ..FilesServiceOptions::default()
    })
}

fn target(project: &str, name: &str) -> ExecutionFileTarget {
    ExecutionFileTarget {
        project_path: project.to_owned(),
        file_path: name.to_owned(),
    }
}

fn directory(path: &str) -> ExecutionDirectoryRequest {
    ExecutionDirectoryRequest {
        directory_path: Some(path.to_owned()),
    }
}

fn list_request(path: &str) -> ExecutionFileListRequest {
    ExecutionFileListRequest {
        project_path: path.to_owned(),
    }
}

async fn bun(root: &Path, command: &str, argument: Option<&Path>) -> Value {
    let output = tokio::time::timeout(
        Duration::from_secs(25),
        Command::new("bun")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/oracles/files-peer.ts"
            ))
            .arg(root)
            .arg(command)
            .args(argument)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    from_slice(&output.stdout).unwrap()
}

async fn snapshot(service: &FilesService, root: &str) -> Value {
    let project = format!("{root}/project");
    let stable = target(&project, "stable.txt");
    let read = service.read(stable.clone(), None).await.unwrap();
    let mut inspected = Vec::new();
    for path in [
        "",
        "project",
        "project/inside-link",
        "project/loop-one",
        "project/escape",
        "project/private",
        "project/stable.txt",
        "absent",
    ] {
        inspected.push(
            inspect_project_directory(path, |input| assert_real_within_base(root, input))
                .await
                .unwrap(),
        );
    }
    json!({
        "tree": serialized(service.tree(directory(&project), None).await.unwrap()),
        "browse": serialized(service.browse(directory(&project), None).await.unwrap()),
        "list": serialized(service.list(list_request(&project), None).await.unwrap()),
        "identity": serialized(service.identity(target(&project, "alias.txt"), None).await.unwrap()),
        "read": { "bytes": STANDARD.encode(read.bytes), "path": read.path, "revision": read.revision },
        "revision": serialized(service.revision(stable, None).await.unwrap()),
        "missing": serialized(service.revision(target(&project, "absent"), None).await.unwrap()),
        "loop": observed(service.identity(target(&project, "loop-one"), None).await),
        "pipe": observed(service.revision(target(&project, "named-pipe"), None).await),
        "outside": observed(service.identity(target(&project, "escape"), None).await),
        "unreadable": observed(service.list(list_request(&format!("{project}/private")), None).await),
        "inspect": serialized(inspected),
    })
}

#[tokio::test]
async fn typescript_and_rust_share_file_identity_metadata_and_order() {
    #[cfg(target_os = "linux")]
    if rustix::process::geteuid().is_root()
        && std::env::var_os("GARCON_FILES_WITHOUT_DAC").is_none()
    {
        // The build host runs tests as root; drop only the child's DAC bypass.
        let output = Command::new("setpriv")
            .args(["--bounding-set=-dac_override,-dac_read_search", "--"])
            .arg(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "files::parity_tests::typescript_and_rust_share_file_identity_metadata_and_order",
                "--nocapture",
            ])
            .env("GARCON_FILES_WITHOUT_DAC", "1")
            .kill_on_drop(true)
            .output()
            .await
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success() && stdout.contains("1 passed"),
            "{stdout}\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    LocalSet::new()
        .run_until(async {
            let temp = tokio::task::spawn_blocking(fixture_tree).await.unwrap();
            let root = temp.0.path().to_str().unwrap();
            let service = service(root);
            let expected = bun(temp.0.path(), "snapshot", None).await;
            let actual = snapshot(&service, root).await;
            for key in expected.as_object().unwrap().keys() {
                assert_eq!(actual[key], expected[key], "snapshot differs at {key}");
            }
            assert_eq!(actual["loop"]["error"]["code"], "FILE_REVISION_CONFLICT");
            assert_eq!(actual["outside"]["error"]["code"], "FILE_OUTSIDE_ROOT");
            assert_eq!(
                actual["pipe"]["error"]["code"],
                "FILE_PATH_MUST_IDENTIFY_FILE"
            );
            #[cfg(target_os = "linux")]
            {
                assert_eq!(
                    actual["unreadable"]["error"]["code"],
                    "FILE_PERMISSION_DENIED"
                );
                assert_eq!(actual["inspect"][5]["reason"], "permission-denied");
            }
            let names: Vec<_> = actual["tree"]["entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(|entry| entry["name"].as_str().unwrap())
                .collect();
            assert!(
                names.iter().position(|name| *name == "10")
                    < names.iter().position(|name| *name == "9")
            );
            assert!(
                names.iter().position(|name| *name == "a")
                    < names.iter().position(|name| *name == "A")
            );
            assert!(!names.contains(&"\u{fffd}\u{fffd}.t"));
            assert!(
                actual["list"]["files"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|entry| entry["name"] == "\u{fffd}\u{fffd}.t")
            );
        })
        .await;
}

#[tokio::test]
async fn typescript_and_rust_agree_on_revisions_after_writes_by_both() {
    LocalSet::new()
        .run_until(async {
            let temp = tokio::task::spawn_blocking(fixture_tree).await.unwrap();
            let root = temp.0.path().to_str().unwrap();
            let stable = target(&format!("{root}/project"), "stable.txt");
            let service = service(root);
            let initial = bun(temp.0.path(), "file", None).await;
            let read = service.read(stable.clone(), None).await.unwrap();
            assert_eq!(
                json!({ "bytes": STANDARD.encode(read.bytes), "path": read.path, "revision": read.revision }),
                initial["read"]
            );
            let first = initial["read"]["revision"].as_str().unwrap();
            let save = service
                .save(
                    ExecutionFileSave {
                        target: stable.clone(),
                        request: SaveTextRequest {
                            content: "a Rust write\n".to_owned(),
                            expected_revision: first.to_owned(),
                            conflict_resolution: FileSaveConflictResolution::Reject,
                        },
                    },
                    None,
                )
                .await
                .unwrap();
            assert_ne!(save.revision, first);
            let after_rust = bun(temp.0.path(), "file", None).await;
            assert_eq!(after_rust["revision"]["revision"], save.revision);
            assert_eq!(
                after_rust["read"]["bytes"],
                STANDARD.encode("a Rust write\n")
            );

            let request_file = temp.0.path().join("save-request.json");
            let request = |revision| {
                json!({"content": "a Bun write\n", "expectedRevision": revision}).to_string()
            };
            tokio::fs::write(&request_file, request(first))
                .await
                .unwrap();
            let conflict = bun(temp.0.path(), "save", Some(&request_file)).await;
            assert_eq!(conflict["error"]["code"], "FILE_REVISION_CONFLICT");
            tokio::fs::write(&request_file, request(&save.revision))
                .await
                .unwrap();
            let bun_saved = bun(temp.0.path(), "save", Some(&request_file)).await;
            let revision = service.revision(stable.clone(), None).await.unwrap();
            assert_eq!(
                serialized(revision),
                json!({"status":"ready","revision":bun_saved["ok"]["revision"]})
            );
            assert_eq!(
                service.read(stable, None).await.unwrap().bytes,
                b"a Bun write\n"
            );
        })
        .await;
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn typescript_and_rust_create_one_directory_in_the_canonical_parent() {
    let temp = tokio::task::spawn_blocking(fixture_tree).await.unwrap();
    let root = temp.0.path().to_str().unwrap();
    let project = format!("{root}/project");
    let service = service(root);
    assert!(
        service.can_create_directories(),
        "Linux build host needs descriptor paths"
    );
    let expected = bun(temp.0.path(), "create", None).await;
    tokio::fs::remove_dir(format!("{project}/folder/with spaces "))
        .await
        .unwrap();
    let created = service
        .create_directory(
            ExecutionDirectoryCreation {
                parent_path: format!("{project}/inside-link"),
                name: "with spaces ".to_owned(),
            },
            None,
        )
        .await
        .unwrap();
    assert_eq!(created.path, format!("{project}/folder/with spaces "));
    assert_eq!(serialized(created), expected["ok"]);
    let recreated = service
        .create_directory(
            ExecutionDirectoryCreation {
                parent_path: format!("{project}/folder"),
                name: "with spaces ".to_owned(),
            },
            None,
        )
        .await;
    assert_eq!(observed(recreated)["error"]["code"], "FILE_ALREADY_EXISTS");
    assert_eq!(
        bun(temp.0.path(), "create", None).await["error"]["code"],
        "FILE_ALREADY_EXISTS"
    );
}

#[tokio::test]
async fn project_inspection_git_and_bounded_mentions_match_typescript() {
    LocalSet::new()
        .run_until(async {
            let temp = tokio::task::spawn_blocking(fixture_tree).await.unwrap();
            let root = temp.0.path().to_str().unwrap();
            let project = temp.0.path().join("project");
            let alias = temp.0.path().join("base-alias");
            symlink(&project, &alias).unwrap();
            let status = Command::new("git")
                .args(["init", "--quiet", "--template="])
                .current_dir(&project)
                .kill_on_drop(true)
                .status().await.unwrap();
            assert!(status.success());
            tokio::fs::write(project.join("design note.md"), b"notes ```\n")
                .await.unwrap();
            symlink("design note.md", project.join("notes-alias")).unwrap();
            for index in 0..6 {
                let large = vec![b'a' + index; 128 * 1024 + 1];
                tokio::fs::write(project.join(format!("big{index}")), large).await.unwrap();
            }
            tokio::fs::write(project.join("excess"), b"not admitted").await.unwrap();
            let prompt = "Check @\"design note.md\" @notes-alias @escape @loop-one @named-pipe @stable.txt, @big0 @big1 @big2 @big3 @big4 @big5 @excess";
            let request = temp.0.path().join("mentions.txt");
            tokio::fs::write(&request, prompt).await.unwrap();
            let expected = bun(temp.0.path(), "project", Some(&request)).await;
            let service = ProjectService::new(root, std::rc::Rc::new(|_| Ok(()))).unwrap();
            let mut inspected = Vec::new();
            for (path, git) in [
                ("project", Some(true)),
                ("project/inside-link", None),
                (root, Some(true)),
            ] {
                inspected.push(service.inspect(
                    ExecutionProjectInspectRequest { project_path: path.to_owned(), include_git_repository: git },
                    None,
                ).await.unwrap());
            }
            let linked_base = ProjectService::new(alias.to_str().unwrap(), std::rc::Rc::new(|_| Ok(()))).unwrap();
            inspected.push(linked_base.inspect(
                ExecutionProjectInspectRequest {
                    project_path: project.join("folder").to_str().unwrap().to_owned(),
                    include_git_repository: None,
                },
                None,
            ).await.unwrap());
            let resolved = service.resolve_file_mentions(
                ResolveFileMentionsRequest { project_path: project.to_str().unwrap().to_owned(), command: prompt.to_owned() },
                None,
            ).await.unwrap();
            assert_eq!(serialized(inspected), expected["inspected"]);
            assert!(resolved.contains("@design note.md\n````\nnotes ```"));
            assert!(resolved.contains("@stable.txt\n[Garcon omitted this binary file.]"));
            assert!(resolved.contains("[Garcon truncated this file at 131072 bytes.]"));
            assert!(resolved.contains("@big3\n[Garcon omitted this file because the @file context limit was reached.]"));
            assert!(!resolved.contains("not in project"));
            assert!(!resolved.contains("\n@named-pipe\n"));
            assert!(!resolved.contains("\n@excess\n"));
            let expected = expected["resolved"].as_str().unwrap();
            assert_eq!(resolved.len(), expected.len(), "different resolved context length");
            assert!(resolved == expected, "different resolved context bytes");
        })
        .await;
}

#[tokio::test]
async fn large_directories_reject_tree_overflow_and_return_bounded_lists() {
    let temp = tokio::task::spawn_blocking(|| {
        let temp = fixture();
        let large = temp.path().join("large");
        std::fs::create_dir(&large).unwrap();
        std::fs::create_dir(large.join("folder")).unwrap();
        for index in 0..3200 {
            let name = format!("{index:04}-{}", "x".repeat(220));
            std::fs::write(large.join(name), []).unwrap();
        }
        temp
    })
    .await
    .unwrap();
    let root = temp.path().to_str().unwrap();
    let large = format!("{root}/large");
    let service = service(root);
    let original = bun(temp.path(), "large", None).await;
    let actual = json!({
        "tree": observed(service.tree(directory(&large), None).await),
        "browse": serialized(service.browse(directory(&large), None).await.unwrap()),
        "list": serialized(service.list(list_request(&large), None).await.unwrap()),
    });
    assert_eq!(actual["tree"]["error"]["code"], "FILE_LIST_TOO_LARGE");
    assert_eq!(actual["browse"].as_array().unwrap().len(), 1);
    assert_eq!(actual["list"]["truncated"], true);
    for key in ["tree", "browse"] {
        assert_eq!(
            actual[key], original[key],
            "large directory differs at {key}"
        );
    }
    assert_eq!(actual["list"]["truncated"], original["list"]["truncated"]);
    let actual = actual["list"]["files"].as_array().unwrap();
    let expected = original["list"]["files"].as_array().unwrap();
    assert_eq!(actual.len(), expected.len(), "large list entry count");
    for (index, (actual, expected)) in actual.iter().zip(expected).enumerate() {
        assert_eq!(actual, expected, "large list entry at {index}");
    }
}
