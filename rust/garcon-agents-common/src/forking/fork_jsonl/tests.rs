use super::*;

use garcon_js::{ManualClock, json::as_number};
use serde_json::json;
use std::path::Path;

fn request(source: &Path, cutoff_line: Option<f64>) -> ForkJsonlRequest {
    ForkJsonlRequest {
        source_path: source.to_str().unwrap().to_owned(),
        source_agent_session_id: "synthetic-source".to_owned(),
        cutoff_line,
        allow_unmaterialized_whole_session: false,
        leading_line_count: None,
        retained_message_counts: IndexMap::new(),
        rewrite_entry: None,
        transform_entries: None,
        create_target_path: None,
    }
}

async fn fork(request: ForkJsonlRequest) -> ExecutorResult<ForkJsonlOutcome> {
    fork_jsonl_transcript_with(request, &ManualClock::new(1_000), || {
        "synthetic-target".to_owned()
    })
    .await
}

fn materialized(outcome: ForkJsonlOutcome) -> (String, Option<String>) {
    match outcome {
        ForkJsonlOutcome::Materialized {
            agent_session_id,
            native_path,
            expected_semantic_digest,
        } => {
            assert_eq!(agent_session_id, "synthetic-target");
            (native_path, expected_semantic_digest)
        }
        outcome => panic!("expected materialized fork, got {outcome:?}"),
    }
}

#[tokio::test]
async fn transforms_a_selected_snapshot_with_access_to_the_full_source_and_retained_counts() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.jsonl");
    fs::write(&source, b"{\"id\":1,\"scaled\":0.0000001,\"large\":9007199254740993}\n\n{\"id\":2}\n{\"id\":3}\n{\"tail\":")
        .await
        .unwrap();
    let mut request = request(&source, Some(3.0));
    request.retained_message_counts.insert(3, 2);
    request.rewrite_entry = Some(Rc::new(|entry, context| {
        assert_eq!(context.source_agent_session_id, "synthetic-source");
        if as_number(&entry["id"]) == Some(2.0) {
            assert_eq!(context.retained_message_count, Some(2));
            Ok(ForkEntryRewrite::Replace(json!({ "id": 20 }).into()))
        } else {
            assert_eq!(context.retained_message_count, None);
            Ok(ForkEntryRewrite::Unchanged)
        }
    }));
    request.transform_entries = Some(Rc::new(|input| {
        Box::pin(async move {
            let ids = |entries: &[Opaque]| {
                entries
                    .iter()
                    .map(|entry| as_number(&entry["id"]).unwrap())
                    .collect::<Vec<_>>()
            };
            assert_eq!(ids(&input.source_entries), [1.0, 2.0, 3.0]);
            assert_eq!(ids(&input.selected_entries), [1.0, 20.0]);
            Ok(ForkTranscriptTransformResult {
                entries: input.selected_entries,
                expected_semantic_digest: Some("synthetic-digest".to_owned()),
            })
        })
    }));
    let (target, digest) = materialized(fork(request).await.unwrap());
    assert_eq!(digest.as_deref(), Some("synthetic-digest"));
    let output = fs::read(target).await.unwrap();
    assert_eq!(
        output,
        b"{\"id\":1,\"scaled\":1e-7,\"large\":9007199254740992}\n{\"id\":20}\n"
    );
    assert_eq!(
        output,
        original_fork(&source, &dir.path().join("original.jsonl"), "point").await
    );
}

#[tokio::test]
async fn rejects_whole_source_mutation_and_removes_created_target() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.jsonl");
    let target = dir.path().join("custom.jsonl");
    fs::write(&source, b"{\"id\":1}\n").await.unwrap();
    let mut request = request(&source, None);
    let expected_target = target.to_str().unwrap().to_owned();
    request.create_target_path = Some(Rc::new(move |input| {
        assert_eq!(input.target_agent_session_id, "synthetic-target");
        assert_eq!(input.created_at_ms, 1_000);
        expected_target.clone()
    }));
    request.transform_entries = Some(Rc::new(move |input| {
        let source = source.clone();
        Box::pin(async move {
            fs::write(source, b"{\"id\":2}\n").await?;
            Ok(ForkTranscriptTransformResult {
                entries: input.selected_entries,
                expected_semantic_digest: None,
            })
        })
    }));
    assert!(
        fork(request)
            .await
            .unwrap_err()
            .is::<JsonlSourcePrefixChangedError>()
    );
    assert!(!fs::try_exists(target).await.unwrap());
}

#[tokio::test]
async fn a_retained_unterminated_line_can_gain_a_separator_but_cannot_change() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.jsonl");
    for (after, succeeds) in [
        (b"{\"id\":1}\n{\"id\":2}\n".as_slice(), true),
        (b"{\"id\":2}\n".as_slice(), false),
    ] {
        fs::write(&source, b"{\"id\":1}").await.unwrap();
        let mut request = request(&source, Some(1.0));
        let mutate = source.clone();
        request.transform_entries = Some(Rc::new(move |input| {
            let mutate = mutate.clone();
            Box::pin(async move {
                fs::write(mutate, after).await?;
                Ok(ForkTranscriptTransformResult {
                    entries: input.selected_entries,
                    expected_semantic_digest: None,
                })
            })
        }));
        if succeeds {
            let (path, _) = materialized(fork(request).await.unwrap());
            assert_eq!(fs::read(&path).await.unwrap(), b"{\"id\":1}\n");
            fs::remove_file(path).await.unwrap();
        } else {
            assert!(
                fork(request)
                    .await
                    .unwrap_err()
                    .is::<JsonlSourcePrefixChangedError>()
            );
        }
    }
}

#[tokio::test]
async fn leaves_missing_and_empty_whole_sources_unmaterialized() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.jsonl");
    for contents in [None, Some(b"\n\n".as_slice())] {
        if let Some(contents) = contents {
            fs::write(&source, contents).await.unwrap();
        }
        let mut request = request(&source, None);
        request.allow_unmaterialized_whole_session = true;
        assert_eq!(
            fork(request).await.unwrap(),
            ForkJsonlOutcome::Unmaterialized
        );
        assert!(
            !fs::try_exists(dir.path().join("synthetic-target.jsonl"))
                .await
                .unwrap()
        );
    }
}

#[tokio::test]
async fn leaves_a_fully_filtered_whole_session_unmaterialized_without_creating_a_target() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.jsonl");
    fs::write(&source, b"{\"id\":1}\n").await.unwrap();
    let mut request = request(&source, None);
    request.allow_unmaterialized_whole_session = true;
    request.create_target_path = Some(Rc::new(|_| panic!("unexpected target")));
    request.transform_entries = Some(Rc::new(|input| {
        Box::pin(async move {
            assert_eq!(input.selected_entries.len(), 1);
            Ok(ForkTranscriptTransformResult {
                entries: Vec::new(),
                expected_semantic_digest: None,
            })
        })
    }));
    assert_eq!(
        fork(request).await.unwrap(),
        ForkJsonlOutcome::Unmaterialized
    );
}

#[tokio::test]
async fn a_truncated_or_deleted_prefix_maps_to_a_revision_change_and_cleans_the_target() {
    for delete in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.jsonl");
        fs::write(&source, b"{\"id\":1}\n{\"id\":2}\n")
            .await
            .unwrap();
        let mut request = request(&source, Some(2.0));
        request.transform_entries = Some(Rc::new(move |input| {
            let source = source.clone();
            Box::pin(async move {
                if delete {
                    fs::remove_file(source).await?;
                } else {
                    fs::write(source, b"{\"id\":1}\n").await?;
                }
                Ok(ForkTranscriptTransformResult {
                    entries: input.selected_entries,
                    expected_semantic_digest: None,
                })
            })
        }));
        assert!(
            fork(request)
                .await
                .unwrap_err()
                .is::<JsonlSourcePrefixChangedError>()
        );
        assert!(!dir.path().join("synthetic-target.jsonl").exists());
    }
}

#[tokio::test]
async fn streaming_whole_fork_matches_the_original_on_the_same_source_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.jsonl");
    let original = dir.path().join("original.jsonl");
    let mut contents = b" {\"id\": 1}\r\n\r\n".to_vec();
    for id in 1..3000 {
        contents.extend(format!("{{\"id\":{id},\"text\":\"{}\"}}\n", "x".repeat(500)).as_bytes());
    }
    contents.extend_from_slice(b"{\"partial\":");
    fs::write(&source, contents).await.unwrap();
    let (rust, _) = materialized(fork(request(&source, None)).await.unwrap());
    assert_eq!(
        fs::read(rust).await.unwrap(),
        original_fork(&source, &original, "whole").await
    );
}

async fn original_fork(source: &Path, target: &Path, mode: &str) -> Vec<u8> {
    let oracle = tokio::process::Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/oracles/fork-jsonl.ts"
        ))
        .arg(source)
        .arg(target)
        .arg(mode)
        .output()
        .await
        .unwrap();
    assert!(
        oracle.status.success(),
        "{}",
        String::from_utf8_lossy(&oracle.stderr)
    );
    fs::read(target).await.unwrap()
}

#[tokio::test]
async fn copies_a_whole_session_snapshot_if_the_source_grows_during_transformation() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.jsonl");
    fs::write(&source, b"{\"id\":1}\n").await.unwrap();
    let mut request = request(&source, None);
    request.transform_entries = Some(Rc::new(move |input| {
        let source = source.clone();
        Box::pin(async move {
            fs::OpenOptions::new()
                .append(true)
                .open(source)
                .await?
                .write_all(b"{\"id\":2}\n")
                .await?;
            Ok(ForkTranscriptTransformResult {
                entries: input.selected_entries,
                expected_semantic_digest: None,
            })
        })
    }));
    let (path, _) = materialized(fork(request).await.unwrap());
    assert_eq!(fs::read(path).await.unwrap(), b"{\"id\":1}\n");
}

#[tokio::test]
async fn retained_positions_preserve_empty_lines_and_ignore_suffix_only_without_a_transform() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.jsonl");
    fs::write(
        &source,
        b"{\"id\":1}\n\n{\"id\":2}\n{\"partial\":\n{\"id\":3}\n",
    )
    .await
    .unwrap();
    let (target, _) = materialized(fork(request(&source, Some(3.0))).await.unwrap());
    assert_eq!(
        fs::read(&target).await.unwrap(),
        b"{\"id\":1}\n\n{\"id\":2}\n"
    );
    fs::remove_file(&target).await.unwrap();
    let mut request = request(&source, Some(3.0));
    request.transform_entries = Some(Rc::new(|input| {
        Box::pin(async move {
            Ok(ForkTranscriptTransformResult {
                entries: input.selected_entries,
                expected_semantic_digest: None,
            })
        })
    }));
    assert_eq!(
        fork(request).await.unwrap_err().to_string(),
        format!("Invalid JSONL at {}:4", source.display())
    );
    assert!(!fs::try_exists(target).await.unwrap());
}

#[tokio::test]
async fn a_retained_prefix_may_not_lose_its_line_terminator() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.jsonl");
    fs::write(&source, b"{\"id\":1}\n").await.unwrap();
    let mut request = request(&source, Some(1.0));
    request.transform_entries = Some(Rc::new(move |input| {
        let source = source.clone();
        Box::pin(async move {
            fs::write(source, b"{\"id\":1}").await?;
            Ok(ForkTranscriptTransformResult {
                entries: input.selected_entries,
                expected_semantic_digest: None,
            })
        })
    }));
    assert!(
        fork(request)
            .await
            .unwrap_err()
            .is::<JsonlSourcePrefixChangedError>()
    );
    assert!(
        !fs::try_exists(dir.path().join("synthetic-target.jsonl"))
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn missing_source_keeps_the_initial_io_error_and_point_forks_cannot_stay_unmaterialized() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.jsonl");
    let error = fork(request(&source, Some(1.0))).await.unwrap_err();
    assert_eq!(
        error.downcast_ref::<io::Error>().unwrap().kind(),
        io::ErrorKind::NotFound
    );
    fs::write(&source, []).await.unwrap();
    let mut request = request(&source, Some(0.0));
    request.allow_unmaterialized_whole_session = true;
    assert_eq!(
        fork(request).await.unwrap_err().to_string(),
        "Only whole-session JSONL forks can remain unmaterialized"
    );
}

#[tokio::test]
async fn an_existing_exclusive_target_survives_the_create_failure() {
    use garcon_base::errors::{ErrorInput, has_node_error_code};

    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.jsonl");
    let target = dir.path().join("synthetic-target.jsonl");
    fs::write(&source, b"{\"id\":1}\n").await.unwrap();
    fs::write(&target, b"{\"existing\":true}\n").await.unwrap();
    let error = fork(request(&source, None)).await.unwrap_err();
    assert!(has_node_error_code(
        ErrorInput::Error(error.as_ref()),
        "EEXIST"
    ));
    assert_eq!(
        error.to_string(),
        format!("EEXIST: file already exists, open '{}'", target.display())
    );
    assert_eq!(fs::read(target).await.unwrap(), b"{\"existing\":true}\n");
}
