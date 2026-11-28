use super::*;

fn envelope(owner: &str, version: i64, values: &str) -> AgentSettingsEnvelope {
    AgentSettingsEnvelope {
        owner_id: owner.into(),
        schema_version: version,
        values: Opaque::parse(values).unwrap(),
    }
}

fn descriptors() -> Vec<AgentSettingDescriptor> {
    json::from_str(
        r#"[
        {"key":"mode","type":"enum","label":"Mode","options":[{"value":"fast","label":"Fast"}]},
        {"key":"count","type":"number","label":"Count","min":0,"max":2,"step":1}
    ]"#,
    )
    .unwrap()
}

#[tokio::test]
async fn validates_envelopes_values_and_patches_without_mutating_the_defaults() {
    let defaults = envelope("test", 1, r#"{"mode":"fast","count":1}"#);
    let settings = VersionedSettings::new(defaults.clone(), descriptors(), None);
    let patched = settings
        .apply_patch(
            defaults.clone(),
            IndexMap::from([("count".into(), Opaque::parse("2").unwrap())]),
        )
        .unwrap();
    assert_eq!(settings.defaults().unwrap(), defaults);
    assert_eq!(patched, envelope("test", 1, r#"{"mode":"fast","count":2}"#));
    assert_eq!(settings.migrate(patched.clone()).await.unwrap(), patched);
    let other = AgentSettingsEnvelope {
        owner_id: "other".into(),
        ..defaults.clone()
    };
    assert_eq!(
        settings.parse(other).unwrap_err().to_string(),
        "Invalid settings for test"
    );
    for (key, value, reason) in [
        ("unknown", "true", "Unknown setting unknown"),
        ("count", "3", "Invalid value for setting count"),
        ("mode", "\"slow\"", "Invalid value for setting mode"),
    ] {
        let error = settings
            .apply_patch(
                defaults.clone(),
                IndexMap::from([(key.into(), Opaque::parse(value).unwrap())]),
            )
            .unwrap_err();
        assert_eq!(error.to_string(), reason);
        assert_eq!(
            error.downcast_ref::<AgentIntegrationError>().unwrap().code,
            AgentIntegrationErrorCode::INVALID_SETTINGS
        );
    }
}

#[tokio::test]
async fn migrates_only_older_owned_values_and_validates_the_result() {
    let settings = VersionedSettings::new(
        envelope("test", 2, "{}"),
        descriptors(),
        Some(Box::new(|version, input| {
            Box::pin(async move {
                assert_eq!(version, 1);
                Ok(if input["converted"].as_bool() == Some(true) {
                    Opaque::parse(r#"{"count":1}"#).unwrap()
                } else {
                    input
                })
            })
        })),
    );
    assert_eq!(
        settings
            .migrate(envelope("test", 1, r#"{"converted":true}"#))
            .await
            .unwrap(),
        envelope("test", 2, r#"{"count":1}"#)
    );
    assert_eq!(
        settings
            .migrate(envelope("test", 1, r#"{"count":3}"#))
            .await
            .unwrap_err()
            .to_string(),
        "Invalid value for setting count"
    );
    for (owner, version) in [("other", 1), ("test", 0), ("test", 3)] {
        assert_eq!(
            settings
                .migrate(envelope(owner, version, "{}"))
                .await
                .unwrap_err()
                .to_string(),
            "Invalid settings for test"
        );
    }
}

#[test]
fn validates_declared_defaults_only_when_read() {
    let settings =
        VersionedSettings::new(envelope("test", 1, r#"{"count":3}"#), descriptors(), None);
    assert_eq!(
        settings.defaults().unwrap_err().to_string(),
        "Invalid value for setting count"
    );
    let current = envelope("test", 1, r#"{"count":1}"#);
    assert_eq!(settings.parse(current.clone()).unwrap(), current);
}
