//! Runtime identity, listener URLs, and private descriptor publication.

use std::io;
use std::path::Path;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use garcon_contract::server_runtime::{
    CliRuntimeDescriptor, LOCAL_CAPABILITY_PREFIX, RuntimeEndpoint, SERVER_RUNTIME_FILENAME,
    SERVER_RUNTIME_SCHEMA_VERSION, ServerRuntimeDescriptor, ServerRuntimeIdentity,
    is_runtime_probe_challenge_text, parse_cli_runtime_descriptor, runtime_proof_payload,
};
use garcon_js::{Clock, InvalidTimeValue, json, number_to_string, path::native, to_iso_string};
use hmac::{Hmac, Mac};
use serde_json::{Value, json as value_json};
use sha2::Sha256;
use tokio::fs;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::{log::Logger, path_boundary::realpath};

#[derive(Debug, Clone)]
pub struct ServerRuntimeState {
    pub identity: ServerRuntimeIdentity,
    pub local_capability: String,
}

#[derive(Debug, thiserror::Error)]
pub enum CreateRuntimeStateError {
    #[error(transparent)]
    Random(#[from] io::Error),
    #[error(transparent)]
    Time(#[from] InvalidTimeValue),
}

pub fn create_server_runtime_state(
    workspace_dir: impl Into<String>,
    clock: &dyn Clock,
) -> Result<ServerRuntimeState, CreateRuntimeStateError> {
    let mut capability = [0; 32];
    getrandom::fill(&mut capability).map_err(|error| io::Error::other(error.to_string()))?;
    Ok(runtime_state_with_identity(
        workspace_dir,
        clock,
        Uuid::new_v4(),
        capability,
    )?)
}

pub fn runtime_state_with_identity(
    workspace_dir: impl Into<String>,
    clock: &dyn Clock,
    instance_id: Uuid,
    capability: [u8; 32],
) -> Result<ServerRuntimeState, InvalidTimeValue> {
    Ok(ServerRuntimeState {
        identity: ServerRuntimeIdentity {
            schema_version: SERVER_RUNTIME_SCHEMA_VERSION,
            instance_id: instance_id.to_string(),
            workspace_dir: workspace_dir.into(),
            started_at: to_iso_string(clock.now_ms())?,
        },
        local_capability: format!(
            "{LOCAL_CAPABILITY_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(capability)
        ),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("runtime challenge is invalid")]
pub struct InvalidRuntimeChallenge;

pub fn create_server_runtime_proof(
    state: &ServerRuntimeState,
    challenge: &str,
) -> Result<String, InvalidRuntimeChallenge> {
    if !is_runtime_probe_challenge_text(challenge) {
        return Err(InvalidRuntimeChallenge);
    }
    // INFALLIBLE: HMAC accepts a key of any size.
    let mut mac =
        Hmac::<Sha256>::new_from_slice(state.local_capability.as_bytes()).expect("HMAC key");
    mac.update(runtime_proof_payload(&state.identity.instance_id, challenge).as_bytes());
    Ok(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}

pub fn advertised_server_url(bind_address: &str, port: f64) -> String {
    let hostname = match bind_address {
        "0.0.0.0" | "::" | "[::]" => "127.0.0.1",
        address => address,
    };
    listening_server_url(hostname, port)
}

pub fn listening_server_url(bind_address: &str, port: f64) -> String {
    let port = number_to_string(port);
    if bind_address.contains(':') && !bind_address.starts_with('[') {
        format!("http://[{bind_address}]:{port}")
    } else {
        format!("http://{bind_address}:{port}")
    }
}

pub struct ServerListener<'a> {
    pub bind_address: &'a str,
    pub port: f64,
    pub auth_disabled: bool,
    pub base_path: Option<&'a str>,
}

pub fn log_server_ready(logger: &impl Logger, listener: ServerListener<'_>) {
    let base_path = listener.base_path.unwrap_or_default();
    logger.info(&format!(
        "Started at {}{base_path}",
        listening_server_url(listener.bind_address, listener.port)
    ));
    logger.info(if listener.auth_disabled {
        "Authentication: DISABLED"
    } else {
        "Authentication: ENABLED"
    });
    if listener.auth_disabled && !matches!(listener.bind_address, "127.0.0.1" | "localhost") {
        logger.warn("WARNING: authentication is disabled while bound to a non-localhost address.");
    }
}

pub struct PublishedRuntime {
    pub descriptor: ServerRuntimeDescriptor,
    pub file_path: String,
}

pub async fn publish_server_runtime(
    state: &ServerRuntimeState,
    base_url: impl Into<String>,
    config_dir: &str,
) -> io::Result<PublishedRuntime> {
    let workspace_dir = realpath(&state.identity.workspace_dir).await?;
    let descriptor = ServerRuntimeDescriptor {
        endpoint: RuntimeEndpoint {
            schema_version: state.identity.schema_version,
            instance_id: state.identity.instance_id.clone(),
            started_at: state.identity.started_at.clone(),
            pid: u64::from(std::process::id()),
            base_url: base_url.into(),
            local_capability: state.local_capability.clone(),
        },
        workspace_dir: workspace_dir.to_string_lossy().into_owned(),
    };
    let file_path = native::join(&[config_dir, SERVER_RUNTIME_FILENAME]);
    publish_descriptor_text(
        &file_path,
        descriptor_on_disk(&CliRuntimeDescriptor::Controller(descriptor.clone())),
    )
    .await?;
    Ok(PublishedRuntime {
        descriptor,
        file_path,
    })
}

pub async fn publish_runtime_descriptor(
    file_path: &str,
    descriptor: &CliRuntimeDescriptor,
) -> io::Result<()> {
    publish_descriptor_text(file_path, descriptor_on_disk(descriptor)).await
}

fn descriptor_on_disk(descriptor: &CliRuntimeDescriptor) -> Value {
    let endpoint = descriptor.endpoint();
    match descriptor {
        CliRuntimeDescriptor::Controller(descriptor) => value_json!({
            "schemaVersion": endpoint.schema_version,
            "instanceId": endpoint.instance_id,
            "workspaceDir": descriptor.workspace_dir,
            "startedAt": endpoint.started_at,
            "pid": endpoint.pid,
            "baseUrl": endpoint.base_url,
            "localCapability": endpoint.local_capability,
        }),
        CliRuntimeDescriptor::ExecutorCli(descriptor) => value_json!({
            "schemaVersion": endpoint.schema_version,
            "instanceId": endpoint.instance_id,
            "startedAt": endpoint.started_at,
            "kind": descriptor.kind,
            "pid": endpoint.pid,
            "baseUrl": endpoint.base_url,
            "localCapability": endpoint.local_capability,
        }),
    }
}

async fn publish_descriptor_text(file_path: &str, descriptor: Value) -> io::Result<()> {
    let temp_path = native::join(&[
        &native::dirname(file_path),
        &format!(
            ".{}.{}.{}.tmp",
            native::basename(file_path),
            std::process::id(),
            Uuid::new_v4()
        ),
    ]);
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&temp_path).await?;
    let write = async {
        let mut text = serde_json::to_vec_pretty(&descriptor)?;
        text.push(b'\n');
        file.write_all(&text).await?;
        file.sync_all().await
    }
    .await;
    drop(file);
    let outcome = match write {
        Ok(()) => fs::rename(&temp_path, file_path).await,
        Err(error) => Err(error),
    };
    if outcome.is_err() {
        let _ = fs::remove_file(&temp_path).await;
    }
    outcome
}

pub async fn remove_server_runtime(
    file_path: impl AsRef<Path>,
    expected_instance_id: &str,
) -> io::Result<bool> {
    let path = file_path.as_ref();
    let Ok(bytes) = fs::read(path).await else {
        return Ok(false);
    };
    let Ok(raw) = json::from_str::<Value>(&String::from_utf8_lossy(&bytes)) else {
        return Ok(false);
    };
    let Ok(descriptor) = parse_cli_runtime_descriptor(&raw) else {
        return Ok(false);
    };
    if descriptor.endpoint().instance_id != expected_instance_id {
        return Ok(false);
    }
    match fs::remove_file(path).await {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use garcon_js::ManualClock;
    use std::cell::RefCell;

    #[test]
    fn advertises_a_contactable_address_but_logs_the_actual_bind_address() {
        for address in ["0.0.0.0", "::", "[::]"] {
            assert_eq!(
                advertised_server_url(address, 8123.0),
                "http://127.0.0.1:8123"
            );
        }
        assert_eq!(listening_server_url("::", 8123.0), "http://[::]:8123");
        assert_eq!(
            listening_server_url("localhost", 8123.0),
            "http://localhost:8123"
        );
    }

    #[test]
    fn reports_listener_readiness_and_warns_only_when_auth_is_disabled_outside_localhost() {
        #[derive(Default)]
        struct Log(RefCell<Vec<(bool, String)>>);
        impl Logger for Log {
            fn debug(&self, _: &str) {}
            fn info(&self, message: &str) {
                self.0.borrow_mut().push((false, message.to_owned()));
            }
            fn warn(&self, message: &str) {
                self.0.borrow_mut().push((true, message.to_owned()));
            }
            fn error(&self, _: &str) {}
        }
        for address in ["127.0.0.1", "localhost", "0.0.0.0", "::"] {
            for auth_disabled in [false, true] {
                let logger = Log::default();
                log_server_ready(
                    &logger,
                    ServerListener {
                        bind_address: address,
                        port: 4321.0,
                        auth_disabled,
                        base_path: Some("/fixture"),
                    },
                );
                let messages = logger.0.into_inner();
                assert_eq!(
                    messages[0],
                    (
                        false,
                        format!(
                            "Started at {}/fixture",
                            listening_server_url(address, 4321.0)
                        )
                    )
                );
                let auth = if auth_disabled { "DISABLED" } else { "ENABLED" };
                assert_eq!(messages[1], (false, format!("Authentication: {auth}")));
                if auth_disabled && !matches!(address, "127.0.0.1" | "localhost") {
                    assert_eq!(&messages[2..], &[(true, "WARNING: authentication is disabled while bound to a non-localhost address.".to_owned())]);
                } else {
                    assert_eq!(messages.len(), 2);
                }
            }
        }
    }

    #[tokio::test]
    async fn publishes_private_runtime_state_and_only_the_owner_removes_it() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().to_str().unwrap();
        let state =
            runtime_state_with_identity(path, &ManualClock::new(0), Uuid::nil(), [0x7f; 32])
                .unwrap();
        let result = publish_server_runtime(&state, "http://127.0.0.1:8123", path)
            .await
            .unwrap();
        let bytes = fs::read(&result.file_path).await.unwrap();
        assert_eq!(bytes.last(), Some(&b'\n'));
        let json = json::from_slice::<Value>(&bytes).unwrap();
        let keys: Vec<_> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            [
                "schemaVersion",
                "instanceId",
                "workspaceDir",
                "startedAt",
                "pid",
                "baseUrl",
                "localCapability"
            ]
        );
        #[cfg(unix)]
        crate::private_file::assert_private_file(&result.file_path)
            .await
            .unwrap();
        assert!(
            !remove_server_runtime(&result.file_path, "another instance")
                .await
                .unwrap()
        );
        assert!(
            remove_server_runtime(&result.file_path, &state.identity.instance_id)
                .await
                .unwrap()
        );
        assert!(
            !remove_server_runtime(&result.file_path, &state.identity.instance_id)
                .await
                .unwrap()
        );
    }
}
