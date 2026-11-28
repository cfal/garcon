//! Ports `server/remote/listener-secret.ts`.

use garcon_base::json_file_store::{JsonFileStore, JsonWriteOptions};
use garcon_base::private_file::assert_private_file;
use garcon_interface::resources::ExecutorResult;
use garcon_js::{json, path::native};
use garcon_link::connection_url::{create_executor_secret, is_executor_secret};
use serde::Serialize;
use serde_json::Value;

const SECRET_FILE: &str = "executor-secret.json";

fn parse_secret(value: &Value) -> ExecutorResult<String> {
    let secret = &value["secret"];
    if json::as_number(&value["version"]) == Some(1.0)
        && is_executor_secret(secret)
        && let Some(secret) = secret.as_str()
    {
        return Ok(secret.to_owned());
    }
    Err("Invalid executor listener credential".into())
}

pub async fn read_listener_secret(data_dir: &str) -> ExecutorResult<String> {
    let file = native::join(&[data_dir, SECRET_FILE]);
    assert_private_file(&file).await?;
    let secret = async {
        let bytes = tokio::fs::read(&file).await?;
        parse_secret(&json::parse(&String::from_utf8_lossy(&bytes))?)
    }
    .await;
    secret.map_err(|_: Box<dyn std::error::Error>| {
        "No valid listener credential found; start the listener first".into()
    })
}

pub async fn load_listener_secret(data_dir: &str) -> ExecutorResult<String> {
    let file = native::join(&[data_dir, SECRET_FILE]);
    assert_private_file(&file).await?;
    let store = JsonFileStore::default();
    let mut created = false;
    let secret = store
        .read_json_state_file(
            &file,
            || {
                created = true;
                create_executor_secret()
            },
            |value| parse_secret(&value),
        )
        .await?;
    if created {
        #[derive(Serialize)]
        struct Credential<'a> {
            version: u8,
            secret: &'a str,
        }
        store
            .write_json_file_atomic(
                &file,
                &Credential {
                    version: 1,
                    secret: &secret,
                },
                JsonWriteOptions {
                    mode: Some(0o600),
                    ..Default::default()
                },
            )
            .await?;
    }
    Ok(secret)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reuses_the_private_listener_secret_without_revealing_missing_ones() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();
        assert_eq!(
            read_listener_secret(path).await.unwrap_err().to_string(),
            "No valid listener credential found; start the listener first"
        );
        let secret = load_listener_secret(path).await.unwrap();
        assert!(is_executor_secret(&Value::String(secret.clone())));
        assert_eq!(load_listener_secret(path).await.unwrap(), secret);
        assert_eq!(read_listener_secret(path).await.unwrap(), secret);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let file = dir.path().join(SECRET_FILE);
            assert_eq!(
                tokio::fs::metadata(&file)
                    .await
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
            tokio::fs::set_permissions(file, std::fs::Permissions::from_mode(0o640))
                .await
                .unwrap();
            assert_eq!(
                read_listener_secret(path).await.unwrap_err().to_string(),
                "Credential file must be accessible only to its OS account"
            );
        }
    }
}
