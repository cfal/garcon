use garcon_agent_claude::native_path::{
    ClaudeNativePathOptions, ClaudeNativePathSession, create_claude_native_path,
    prepare_claude_native_session_relocation, resolve_claude_native_path,
    sanitize_claude_project_path,
};
use garcon_cases::{CaseError, replay, text};
use garcon_interface::errors::{AgentIntegrationError, AgentIntegrationErrorCode};
use garcon_js::path::native as path;
use serde_json::Value;
use tokio::fs;

fn options(config: &str) -> ClaudeNativePathOptions<'_> {
    ClaudeNativePathOptions {
        home_dir: "unused",
        config_home_dir: Some(config),
        logger: None,
    }
}

#[test]
fn recorded_native_path_encoding_matches() {
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/native-path"),
        |function, args| {
            if function != "sanitizeClaudeProjectPath" {
                return Err(CaseError::unhandled(function));
            }
            let path = text(function, args.first())?.expect("recorded project path");
            Ok(Value::String(sanitize_claude_project_path(path)))
        },
    );
}

#[cfg(unix)]
#[tokio::test]
async fn canonicalizes_symlinks_and_uses_claude_project_encoding() {
    let fixture = tempfile::tempdir().unwrap();
    let config = fixture.path().join("config");
    let project = fixture
        .path()
        .join("repo")
        .join(".worktrees")
        .join("simplify");
    let alias = fixture.path().join("project-alias");
    fs::create_dir_all(&project).await.unwrap();
    fs::symlink(&project, &alias).await.unwrap();
    let project = fs::canonicalize(project).await.unwrap();
    let encoded = sanitize_claude_project_path(project.to_str().unwrap());
    let expected = config
        .join("projects")
        .join(encoded)
        .join("session-1.jsonl");
    assert_eq!(
        create_claude_native_path(
            alias.to_str().unwrap(),
            "session-1",
            &options(config.to_str().unwrap())
        )
        .await
        .as_deref(),
        expected.to_str()
    );
}

#[tokio::test]
async fn normalizes_the_canonical_project_path_to_nfc() {
    let fixture = tempfile::tempdir().unwrap();
    let config = fixture.path().join("config");
    let project = fixture.path().join("cafe\u{301}");
    fs::create_dir_all(&project).await.unwrap();
    let expected = create_claude_native_path(
        project.to_str().unwrap(),
        "session-1",
        &options(config.to_str().unwrap()),
    )
    .await
    .unwrap();
    assert!(expected.ends_with(&path::join(&["-caf-", "session-1.jsonl"])));
}

#[tokio::test]
async fn recovers_within_a_custom_config_home_inferred_from_the_stored_path() {
    let fixture = tempfile::tempdir().unwrap();
    let custom = fixture.path().join("custom");
    let default = fixture.path().join("default");
    let project = fixture.path().join("repo");
    fs::create_dir_all(&project).await.unwrap();
    let custom_home = options(custom.to_str().unwrap());
    let actual = create_claude_native_path(project.to_str().unwrap(), "session-1", &custom_home)
        .await
        .unwrap();
    fs::create_dir_all(path::dirname(&actual)).await.unwrap();
    fs::write(&actual, b"{}\n").await.unwrap();
    let stored = custom
        .join("projects")
        .join("stale")
        .join("session-1.jsonl");
    let resolved = resolve_claude_native_path(
        ClaudeNativePathSession {
            project_path: project.to_str().unwrap(),
            agent_session_id: Some("session-1"),
            native_path: stored.to_str(),
        },
        &options(default.to_str().unwrap()),
    )
    .await
    .unwrap();
    assert_eq!(resolved.as_deref(), Some(actual.as_str()));
    let original = tokio::process::Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/oracles/native-path.ts"
        ))
        .args([
            project.to_str().unwrap(),
            default.to_str().unwrap(),
            stored.to_str().unwrap(),
        ])
        .output()
        .await
        .unwrap();
    assert!(
        original.status.success(),
        "{}",
        String::from_utf8_lossy(&original.stderr)
    );
    assert_eq!(original.stdout, serde_json::to_vec(&resolved).unwrap());
}

#[tokio::test]
async fn searches_all_project_directories_after_a_derivation_miss_and_refuses_duplicates() {
    let fixture = tempfile::tempdir().unwrap();
    let config = fixture.path().join("config");
    let project = fixture.path().join("repo");
    let first = config.join("projects").join("other-one");
    let second = config.join("projects").join("other-two");
    let options = options(config.to_str().unwrap());
    let find_session = || ClaudeNativePathSession {
        project_path: project.to_str().unwrap(),
        agent_session_id: Some("session-1"),
        native_path: None,
    };
    assert_eq!(
        resolve_claude_native_path(find_session(), &options)
            .await
            .unwrap(),
        None
    );
    fs::create_dir_all(&first).await.unwrap();
    fs::write(first.join("session-1.jsonl"), b"{}\n")
        .await
        .unwrap();
    assert_eq!(
        resolve_claude_native_path(find_session(), &options)
            .await
            .unwrap()
            .as_deref(),
        first.join("session-1.jsonl").to_str()
    );
    fs::create_dir_all(&second).await.unwrap();
    fs::write(second.join("session-1.jsonl"), b"{}\n")
        .await
        .unwrap();
    let error = resolve_claude_native_path(find_session(), &options)
        .await
        .unwrap_err();
    let error = error.downcast_ref::<AgentIntegrationError>().unwrap();
    assert_eq!(
        error.code,
        AgentIntegrationErrorCode::TRANSCRIPT_UNAVAILABLE
    );
    assert_eq!(
        error.message,
        "Multiple Claude native transcripts match the selected session"
    );
}

#[tokio::test]
async fn copies_all_session_artifacts_before_removing_the_source_on_commit() {
    let root = tempfile::tempdir().unwrap();
    let config = root.path().join("config");
    let previous = root.path().join("previous");
    let next = root.path().join("next");
    let options = options(config.to_str().unwrap());
    let previous = previous.to_str().unwrap();
    let next = next.to_str().unwrap();
    let source = create_claude_native_path(previous, "session-1", &options)
        .await
        .unwrap();
    let target = create_claude_native_path(next, "session-1", &options)
        .await
        .unwrap();
    let source_dir = std::path::Path::new(&source).parent().unwrap();
    let target_dir = std::path::Path::new(&target).parent().unwrap();
    fs::create_dir_all(source_dir.join("session-1").join("nested"))
        .await
        .unwrap();
    fs::create_dir_all(target_dir.join("session-1"))
        .await
        .unwrap();
    fs::write(&source, b"{}\n").await.unwrap();
    fs::write(source_dir.join("session-1.queue.json"), b"[]\n")
        .await
        .unwrap();
    fs::write(source_dir.join("session-1/nested/fixture"), b"fixture\n")
        .await
        .unwrap();
    fs::write(target_dir.join("session-1/stale"), b"stale\n")
        .await
        .unwrap();
    let pending = prepare_claude_native_session_relocation(
        previous,
        next,
        "session-1",
        Some(&source),
        &options,
    )
    .await
    .unwrap();
    assert_eq!(pending.native_path, target);
    assert_eq!(fs::read(&source).await.unwrap(), b"{}\n");
    assert_eq!(fs::read(&target).await.unwrap(), b"{}\n");
    assert_eq!(
        fs::read(target_dir.join("session-1.queue.json"))
            .await
            .unwrap(),
        b"[]\n"
    );
    assert_eq!(
        fs::read(target_dir.join("session-1/nested/fixture"))
            .await
            .unwrap(),
        b"fixture\n"
    );
    assert!(
        !fs::try_exists(target_dir.join("session-1/stale"))
            .await
            .unwrap()
    );
    pending.commit().await.unwrap();
    assert!(!fs::try_exists(&source).await.unwrap());
    assert!(
        !fs::try_exists(source_dir.join("session-1.queue.json"))
            .await
            .unwrap()
    );
    assert!(!fs::try_exists(source_dir.join("session-1")).await.unwrap());
    assert!(fs::try_exists(target_dir.join("session-1")).await.unwrap());
}

#[tokio::test]
async fn removes_only_prepared_destination_artifacts_on_rollback() {
    let root = tempfile::tempdir().unwrap();
    let config = root.path().join("config");
    let previous = root.path().join("previous");
    let next = root.path().join("next");
    let options = options(config.to_str().unwrap());
    let previous = previous.to_str().unwrap();
    let next = next.to_str().unwrap();
    let source = create_claude_native_path(previous, "session-1", &options)
        .await
        .unwrap();
    fs::create_dir_all(path::dirname(&source)).await.unwrap();
    fs::write(&source, b"{}\n").await.unwrap();
    let pending = prepare_claude_native_session_relocation(
        previous,
        next,
        "session-1",
        Some(&source),
        &options,
    )
    .await
    .unwrap();
    assert!(fs::try_exists(&pending.native_path).await.unwrap());
    pending.rollback().await.unwrap();
    assert!(!fs::try_exists(&pending.native_path).await.unwrap());
    assert_eq!(fs::read(&source).await.unwrap(), b"{}\n");
}

#[tokio::test]
async fn rejects_session_ids_that_could_escape_recursive_artifact_cleanup() {
    let err =
        prepare_claude_native_session_relocation("old", "new", "../escape", None, &options("fake"))
            .await
            .err()
            .expect("must reject before accessing disk");
    let err = err.downcast_ref::<AgentIntegrationError>().unwrap();
    assert_eq!(err.code, AgentIntegrationErrorCode::TRANSCRIPT_UNAVAILABLE);
    assert_eq!(
        err.message,
        "Claude session transcript is outside the expected project-state directory"
    );
}

#[tokio::test]
async fn returns_a_no_op_relocation_for_the_same_canonical_project() {
    let root = tempfile::tempdir().unwrap();
    let config = root.path().join("config");
    let project = root.path().join("repo");
    fs::create_dir_all(&project).await.unwrap();
    let options = options(config.to_str().unwrap());
    let project = project.to_str().unwrap();
    let source = create_claude_native_path(project, "session-1", &options)
        .await
        .unwrap();
    fs::create_dir_all(path::dirname(&source)).await.unwrap();
    fs::write(&source, b"{}\n").await.unwrap();
    let equivalent_project = format!("{project}/.");
    let pending = prepare_claude_native_session_relocation(
        project,
        &equivalent_project,
        "session-1",
        Some(&source),
        &options,
    )
    .await
    .unwrap();
    assert_eq!(pending.native_path, source);
    pending.rollback().await.unwrap();
    pending.commit().await.unwrap();
    assert_eq!(fs::read(&source).await.unwrap(), b"{}\n");
}

#[tokio::test]
async fn rejects_missing_and_structurally_unsafe_source_transcripts() {
    let root = tempfile::tempdir().unwrap();
    let config = root.path().join("config");
    let options = options(config.to_str().unwrap());
    let error =
        prepare_claude_native_session_relocation("previous", "next", "session-1", None, &options)
            .await
            .err()
            .unwrap();
    assert_eq!(
        error.to_string(),
        "Claude session transcript could not be resolved for project-path update"
    );
    let unsafe_source = root.path().join("session-1.jsonl");
    fs::write(&unsafe_source, b"{}\n").await.unwrap();
    let error = prepare_claude_native_session_relocation(
        "previous",
        "next",
        "session-1",
        unsafe_source.to_str(),
        &options,
    )
    .await
    .err()
    .unwrap();
    assert_eq!(
        error.to_string(),
        "Claude session transcript is outside the expected project-state directory"
    );
    assert_eq!(fs::read(unsafe_source).await.unwrap(), b"{}\n");
}
