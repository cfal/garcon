use std::cell::Cell;

use garcon_contract::agent_execution::AgentCredentialReferenceKind;

use super::*;

fn options(workspace: &Path) -> IntegrationHostFactoryOptions {
    IntegrationHostFactoryOptions {
        workspace_dir: workspace.to_str().unwrap().into(),
        executor_id: None,
        instance_id: None,
        resolve_credential: Rc::new(|_| Box::pin(async { Ok(None) })),
        read_environment: None,
        logger_factory: None,
    }
}

fn storage(workspace: &Path) -> Rc<dyn AgentScopedStorage> {
    IntegrationHostFactory::new(options(workspace))
        .for_agent("alpha")
        .unwrap()
        .storage
}

async fn put(path: &Path, contents: &str) {
    fs::create_dir_all(path.parent().unwrap()).await.unwrap();
    fs::write(path, contents).await.unwrap();
}

#[tokio::test]
async fn claims_nested_storage_and_finishes_partially_completed_moves_without_overwriting() {
    let workspace = tempfile::tempdir().unwrap();
    let storage = storage(workspace.path());
    let source = workspace.path().join("legacy-sessions");
    let destination = Path::new(storage.root_directory()).join("legacy-sessions");
    assert_eq!(
        storage
            .claim_legacy_workspace_directory("legacy-sessions")
            .await
            .unwrap(),
        AgentLegacyDirectoryClaim {
            moved: 0,
            skipped: 0
        }
    );
    put(&source.join("root.jsonl"), "root").await;
    put(&source.join("endpoint/nested.jsonl"), "nested").await;
    put(&destination.join("endpoint/previous.jsonl"), "previous").await;
    assert_eq!(
        storage
            .claim_legacy_workspace_directory("legacy-sessions")
            .await
            .unwrap(),
        AgentLegacyDirectoryClaim {
            moved: 2,
            skipped: 0
        }
    );
    assert!(!source.exists());
    for (name, expected) in [
        ("root.jsonl", "root"),
        ("endpoint/nested.jsonl", "nested"),
        ("endpoint/previous.jsonl", "previous"),
    ] {
        assert_eq!(
            fs::read_to_string(destination.join(name)).await.unwrap(),
            expected
        );
    }
    put(&source.join("root.jsonl"), "legacy copy").await;
    assert_eq!(
        storage
            .claim_legacy_workspace_directory("legacy-sessions")
            .await
            .unwrap(),
        AgentLegacyDirectoryClaim {
            moved: 0,
            skipped: 1
        }
    );
    assert_eq!(
        fs::read_to_string(source.join("root.jsonl")).await.unwrap(),
        "legacy copy"
    );
    assert_eq!(
        fs::read_to_string(destination.join("root.jsonl"))
            .await
            .unwrap(),
        "root"
    );
}

#[tokio::test]
async fn refuses_traversal_and_encoded_namespace_names() {
    let workspace = tempfile::tempdir().unwrap();
    let storage = storage(workspace.path());
    assert_eq!(
        storage.directory("search").await.unwrap(),
        realpath(Path::new(storage.root_directory()).join("search"))
            .await
            .unwrap()
            .to_string_lossy()
    );
    for name in [
        "../escape",
        "%2e%2e",
        "",
        ".",
        "..",
        "a/b",
        "a\\b",
        "C:root",
    ] {
        let error = storage.directory(name).await.unwrap_err();
        assert_eq!(
            error.downcast_ref::<AgentIntegrationError>().unwrap().code,
            AgentIntegrationErrorCode::INVALID_SETTINGS
        );
        assert_eq!(
            error.to_string(),
            format!("Invalid agent storage namespace: {name}")
        );
        assert!(
            storage
                .claim_legacy_workspace_directory(name)
                .await
                .is_err()
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn never_traverses_symlinked_legacy_entries_or_namespace_roots() {
    let workspace = tempfile::tempdir().unwrap();
    let storage = storage(workspace.path());
    let source = workspace.path().join("legacy-sessions");
    let outside = workspace.path().join("outside");
    put(&outside.join("session.jsonl"), "outside").await;
    fs::create_dir(&source).await.unwrap();
    fs::symlink(&outside, source.join("linked")).await.unwrap();
    assert_eq!(
        storage
            .claim_legacy_workspace_directory("legacy-sessions")
            .await
            .unwrap(),
        AgentLegacyDirectoryClaim {
            moved: 0,
            skipped: 1
        }
    );
    assert_eq!(
        fs::read_to_string(outside.join("session.jsonl"))
            .await
            .unwrap(),
        "outside"
    );
    assert!(
        !Path::new(storage.root_directory())
            .join("legacy-sessions/linked")
            .exists()
    );
    let top_link = workspace.path().join("top-link");
    fs::symlink(&outside, &top_link).await.unwrap();
    let error = storage
        .claim_legacy_workspace_directory("top-link")
        .await
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        format!(
            "Agent storage path must not be a symbolic link: {}",
            top_link.display()
        )
    );
    fs::symlink(&outside, Path::new(storage.root_directory()).join("bad"))
        .await
        .unwrap();
    assert!(
        storage
            .directory("bad")
            .await
            .unwrap_err()
            .is::<AgentIntegrationError>()
    );
}

#[tokio::test]
async fn environment_reads_and_credentials_are_bound_to_the_injected_host() {
    let workspace = tempfile::tempdir().unwrap();
    let read_count = Rc::new(Cell::new(0));
    let mut options = options(workspace.path());
    options.executor_id = Some("worker-1".into());
    options.instance_id = Some("worker-instance".into());
    options.read_environment = Some(Rc::new({
        let count = read_count.clone();
        move |name| {
            count.set(count.get() + 1);
            (name == "ALPHA_BIN").then(|| "alpha-bin".into())
        }
    }));
    options.resolve_credential = Rc::new(|request| {
        Box::pin(async move {
            assert_eq!(request.agent_id, "alpha");
            assert_eq!(request.executor_id, "worker-1");
            assert_eq!(request.reference.endpoint_id, "endpoint-1");
            assert!(request.signal.is_cancelled());
            Ok(Some(AgentResolvedCredential {
                kind: "bearer".into(),
                value: "synthetic credential".into(),
            }))
        })
    });
    let factory = IntegrationHostFactory::new(options);
    assert!(factory.for_agent("../invalid").is_err());
    assert!(factory.bind_configuration("beta", []).is_err());
    let host = factory.for_agent("alpha").unwrap();
    assert_eq!(host.scope.instance_id, "worker-instance");
    let error = host.environment.get("ALPHA_BIN").unwrap_err();
    assert_eq!(
        error.downcast_ref::<AgentIntegrationError>().unwrap().code,
        AgentIntegrationErrorCode::INVALID_SETTINGS
    );
    assert_eq!(
        error.to_string(),
        "Agent attempted to read undeclared environment variable: ALPHA_BIN"
    );
    factory
        .bind_configuration("alpha", ["ALPHA_BIN".to_owned(), "ABSENT".to_owned()])
        .unwrap();
    assert!(factory.bind_configuration("alpha", []).is_err());
    assert!(Rc::ptr_eq(
        &host.environment,
        &factory.for_agent("alpha").unwrap().environment
    ));
    assert_eq!(
        host.environment.get("ALPHA_BIN").unwrap().as_deref(),
        Some("alpha-bin")
    );
    assert_eq!(host.environment.get("ABSENT").unwrap(), None);
    assert!(host.environment.get("SECRET").is_err());
    assert_eq!(read_count.get(), 2);
    let signal = CancellationToken::new();
    signal.cancel();
    let credential = host
        .api_providers
        .resolve_credential(AgentResolveCredentialRequest {
            reference: AgentCredentialReference {
                kind: AgentCredentialReferenceKind::ApiProviderEndpoint,
                api_provider_id: "provider-1".into(),
                endpoint_id: "endpoint-1".into(),
                revision: 1,
            },
            signal,
        })
        .await
        .unwrap()
        .unwrap();
    assert_eq!(credential.value, "synthetic credential");
}
