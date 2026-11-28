use std::{collections::BTreeMap, future::Future, path::Path, rc::Rc, time::Duration};

use garcon_interface::{host::AgentEnvironmentReader, resources::ExecutorResult};

pub struct Environment(pub BTreeMap<String, String>);

impl AgentEnvironmentReader for Environment {
    fn get(&self, name: &str) -> ExecutorResult<Option<String>> {
        Ok(self.0.get(name).cloned())
    }
}

pub fn environment(binary: &Path, method: Option<&str>, api_key: Option<&str>) -> Rc<Environment> {
    let mut env = BTreeMap::from([(
        "GARCON_ANTIGRAVITY_BINARY".into(),
        binary.to_string_lossy().into_owned(),
    )]);
    if let Some(method) = method {
        env.insert("GARCON_ANTIGRAVITY_AUTH_METHOD".into(), method.into());
    }
    if let Some(api_key) = api_key {
        env.insert("GEMINI_API_KEY".into(), api_key.into());
    }
    Rc::new(Environment(env))
}

pub fn executable(path: &Path, script: &str) {
    use std::fs::{OpenOptions, Permissions, set_permissions};
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o700)
        .open(path)
        .unwrap();
    file.write_all(script.as_bytes()).unwrap();
    drop(file);
    set_permissions(path, Permissions::from_mode(0o700)).unwrap();
}

pub async fn bounded(test: impl Future<Output = ()>) {
    tokio::task::LocalSet::new()
        .run_until(async {
            tokio::time::timeout(Duration::from_secs(10), test)
                .await
                .expect("Antigravity fixture must settle");
        })
        .await;
}
