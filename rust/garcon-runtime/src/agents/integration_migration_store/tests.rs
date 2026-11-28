use indexmap::IndexMap;

use super::*;

fn update(expected: f64, next: f64, values: &[(&str, &str)]) -> AgentMigrationCommit {
    AgentMigrationCommit {
        expected_version: Number(expected),
        next_version: Number(next),
        set: values
            .iter()
            .map(|(key, value)| ((*key).into(), Opaque::parse(value).unwrap()))
            .collect::<IndexMap<_, _>>(),
        delete: Vec::new(),
    }
}

#[tokio::test]
async fn names_malformed_state_without_echoing_or_quarantining_it() {
    let workspace = tempfile::tempdir().unwrap();
    let store = FileAgentMigrationStore::new(workspace.path().to_str().unwrap(), "alpha");
    fs::create_dir_all(native::dirname(&store.file_path))
        .await
        .unwrap();
    for contents in [
        r#"{"version": SYNTHETIC_SENTINEL"#,
        r#"{"version":1,"values":[]}"#,
        r#"{"version":9007199254740992,"values":{}}"#,
    ] {
        fs::write(&store.file_path, contents).await.unwrap();
        let error = store.get_version().await.unwrap_err();
        assert_eq!(
            error.to_string(),
            format!("Invalid agent migration state: {}", store.file_path)
        );
        assert!(!format!("{error:?}").contains("SYNTHETIC_SENTINEL"));
        assert_eq!(
            fs::read_to_string(&store.file_path).await.unwrap(),
            contents
        );
    }
}

#[tokio::test]
async fn serializes_competing_commits_and_preserves_the_stored_format() {
    tokio::task::LocalSet::new().run_until(async {
        let workspace = tempfile::tempdir().unwrap();
        let dir = workspace.path().to_str().unwrap();
        let first = FileAgentMigrationStore::new(dir, "alpha");
        let second = FileAgentMigrationStore::new(dir, "alpha");
        let unrelated = FileAgentMigrationStore::new(dir, "beta");
        assert_eq!(first.get_version().await.unwrap(), Number(0.0));
        assert_eq!(first.read("missing").await.unwrap(), None);
        let (result, stale) = tokio::join!(
            first.commit(update(0.0, 2.0, &[("z", "null"), ("10", "10.0"), ("alpha", "true")])),
            second.commit(update(0.0, 3.0, &[("loser", "true")]))
        );
        result.unwrap();
        assert_eq!(stale.unwrap_err().to_string(), "Agent migration version changed: expected 0, found 2");
        assert_eq!(second.read("z").await.unwrap(), Some(Opaque::default()));
        assert_eq!(second.read("loser").await.unwrap(), None);
        assert_eq!(unrelated.get_version().await.unwrap(), Number(0.0));
        let mut next = update(2.0, 4.0, &[("z", "3"), ("1", "1e-7")]);
        next.delete.push("alpha".into());
        second.commit(next).await.unwrap();
        assert_eq!(first.read("alpha").await.unwrap(), None);
        assert_eq!(fs::read_to_string(&first.file_path).await.unwrap(),
            "{\n  \"version\": 4,\n  \"values\": {\n    \"1\": 1e-7,\n    \"10\": 10,\n    \"z\": 3\n  }\n}\n");
    }).await;
}
