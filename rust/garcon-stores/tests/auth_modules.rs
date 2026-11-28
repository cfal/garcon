use garcon_cases::{CaseError, replay, unknown};
use garcon_js::ManualClock;
use serde::Deserialize;
use serde_json::json;
use std::path::Path;
use std::process::Command;
use std::rc::Rc;

use garcon_stores::auth::passwords::{BunPasswords, Passwords};
use garcon_stores::auth::sessions::{AuthBrowserSession, parse_stored_sessions};
use garcon_stores::auth::store::AuthAccountStore;
use garcon_stores::auth::token::AuthTokens;

#[test]
fn stored_session_parser_matches_the_original() {
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/auth-sessions"),
        |function, args| {
            if function != "parseStoredSessions" {
                return Err(CaseError::unhandled(function));
            }
            let value = unknown(function, args.first())?;
            parse_stored_sessions(value.as_ref())
                .map(|sessions| json!(sessions))
                .map_err(|error| CaseError::new("Error", error.to_string()))
        },
    );
}

#[derive(Deserialize)]
struct PasswordFixture {
    password: String,
    hash: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FromBun {
    token: String,
    wrong_key: String,
    password: String,
    hashes: Vec<PasswordFixture>,
    owner_key: String,
    session_id: String,
    expires_at_ms: u64,
}

fn bun_interop(stage: &str, dir: &Path) {
    let output = Command::new("bun")
        .arg("rust/garcon-stores/tests/oracles/auth-crypto.ts")
        .arg(stage)
        .arg(dir)
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "Bun auth {stage}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
async fn original_and_rust_share_auth_and_session_files_passwords_and_tokens() {
    let root = tempfile::tempdir().unwrap();
    bun_interop("prepare", root.path());
    let bytes = tokio::fs::read(root.path().join("from-bun.json"))
        .await
        .unwrap();
    let fixture: FromBun = garcon_js::json::from_slice(&bytes).unwrap();
    let clock = Rc::new(ManualClock::new(1_700_000_000_000));
    let store = AuthAccountStore::open(root.path().to_str().unwrap(), clock.clone())
        .await
        .unwrap();
    let snapshot = store.snapshot().await.unwrap();
    let passwords = BunPasswords;
    let account = snapshot.account.as_ref().unwrap();
    assert!(
        passwords
            .verify(&fixture.password, &account.password_hash)
            .await
            .unwrap()
    );
    assert!(
        !passwords
            .verify(&("a".repeat(72) + "B"), &account.password_hash)
            .await
            .unwrap()
    );
    for probe in &fixture.hashes {
        assert!(
            passwords
                .verify(&probe.password, &probe.hash)
                .await
                .unwrap()
        );
    }
    let tokens = AuthTokens::new("30d".into(), clock.clone());
    let claims = tokens
        .verify_auth_token_claims(&store, Some(&fixture.token))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claims.identity.owner_key, fixture.owner_key);
    assert_eq!(claims.identity.session_id, fixture.session_id);
    assert_eq!(claims.expires_at_ms, fixture.expires_at_ms);
    assert!(
        tokens
            .verify_auth_token_claims(&store, Some(&fixture.wrong_key))
            .await
            .unwrap()
            .is_none()
    );

    let password = "\u{e9}".repeat(37);
    let mut replacement = account.clone();
    replacement.username = "fixture-next".into();
    replacement.credential_revision = 2;
    replacement.password_hash = passwords.hash(&password).await.unwrap();
    store
        .commit(&snapshot, || Ok((replacement, ())))
        .await
        .unwrap();
    assert!(
        tokens
            .verify_auth_token_claims(&store, Some(&fixture.token))
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        tokens
            .verify_logout_token(&store, Some(&fixture.token))
            .await
            .unwrap()
            .is_some()
    );
    let updated = store.snapshot().await.unwrap();
    let token = tokens
        .sign_auth_snapshot(
            &updated,
            &AuthBrowserSession {
                owner_key: fixture.owner_key,
                session_id: fixture.session_id,
                expires_at_ms: fixture.expires_at_ms,
            },
        )
        .unwrap();
    let (issued, issued_token) = store
        .open_session(&updated, || {
            let (session, token) = tokens.prepare_auth_session(&updated)?;
            Ok((session.clone(), (session, token)))
        })
        .await
        .unwrap();
    let mut hashes = Vec::new();
    for password in ["a".repeat(72), "a".repeat(72) + "A", "hello\0world".into()] {
        hashes.push(
            json!({ "password": password, "hash": passwords.hash(&password).await.unwrap() }),
        );
    }
    let output = serde_json::to_vec(&json!({
        "password": password, "token": token, "hashes": hashes,
        "issued": issued, "issuedToken": issued_token,
    }))
    .unwrap();
    tokio::fs::write(root.path().join("from-rust.json"), output)
        .await
        .unwrap();
    bun_interop("verify", root.path());
}
