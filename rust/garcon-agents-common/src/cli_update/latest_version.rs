use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
    time::Duration,
};

use futures::{
    FutureExt,
    future::{LocalBoxFuture, Shared},
};
use garcon_js::{
    clock::{Clock, SystemClock},
    json,
};
use serde_json::Value;
use tokio::sync::OnceCell;

use super::{
    bounded_command::{BoundedCommandOptions, run_bounded_command},
    cli_probe::find_executable,
    cli_version::is_cli_version,
    installer_environment::Environment,
};

pub type LatestVersionLookup = Box<
    dyn FnOnce() -> LocalBoxFuture<
        'static,
        garcon_interface::resources::ExecutorResult<Option<String>>,
    >,
>;
type LookupResult = Shared<LocalBoxFuture<'static, Option<String>>>;

const FOUND_TTL_MS: i64 = 60 * 60 * 1000;
const MISSING_TTL_MS: i64 = 60 * 1000;
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(4);
const TOOL_LOOKUP_TIMEOUT: Duration = Duration::from_secs(10);
const TOOL_LOOKUP_MAX_BYTES: usize = 256 * 1024;
const NPM_REGISTRY_URL: &str = "https://registry.npmjs.org";

struct CacheEntry {
    value: LookupResult,
    expires_at: Rc<Cell<i64>>,
}

#[derive(Clone)]
pub struct LatestVersionCache {
    entries: Rc<RefCell<HashMap<String, CacheEntry>>>,
    clock: Rc<dyn Clock>,
}

impl Default for LatestVersionCache {
    fn default() -> Self {
        Self::new(Rc::new(SystemClock))
    }
}

impl LatestVersionCache {
    pub fn new(clock: Rc<dyn Clock>) -> Self {
        Self {
            entries: Rc::default(),
            clock,
        }
    }

    pub fn get(&self, key: String, lookup: LatestVersionLookup, fresh: bool) -> LookupResult {
        if !fresh
            && let Some(entry) = self.entries.borrow().get(&key)
            && entry.expires_at.get() > self.clock.now_ms()
        {
            return entry.value.clone();
        }
        let entries = Rc::downgrade(&self.entries);
        let clock = self.clock.clone();
        let expires_at = Rc::new(Cell::new(i64::MAX));
        let lookup_expiry = expires_at.clone();
        let lookup_key = key.clone();
        let lookup = lookup();
        let value = async move {
            match lookup.await {
                Ok(version) => {
                    let version = version.filter(|version| is_cli_version(version));
                    let ttl = if version.is_some() {
                        FOUND_TTL_MS
                    } else {
                        MISSING_TTL_MS
                    };
                    lookup_expiry.set(clock.now_ms().saturating_add(ttl));
                    version
                }
                Err(_) => {
                    if let Some(entries) = entries.upgrade() {
                        let mut entries = entries.borrow_mut();
                        if entries
                            .get(&lookup_key)
                            .is_some_and(|entry| Rc::ptr_eq(&entry.expires_at, &lookup_expiry))
                        {
                            entries.remove(&lookup_key);
                        }
                    }
                    None
                }
            }
        }
        .boxed_local()
        .shared();
        self.entries.borrow_mut().insert(
            key,
            CacheEntry {
                value: value.clone(),
                expires_at,
            },
        );
        tokio::task::spawn_local(value.clone());
        value
    }

    pub fn clear(&self) {
        self.entries.borrow_mut().clear();
    }
}

pub fn npm_latest_version(package_name: String, env: Environment) -> LatestVersionLookup {
    Box::new(move || {
        async move {
            let Some(npm) = find_executable("npm", &env) else {
                return Ok(fetch_npm_registry_version(&package_name).await);
            };
            let args = vec![
                "view".into(),
                "--global".into(),
                "--json".into(),
                format!("{package_name}@latest"),
                "version".into(),
            ];
            let result = run_bounded_command(&npm, &args, lookup_options(&env)).await?;
            if result.exit_code != Some(0) || result.truncated {
                return Ok(None);
            }
            Ok(parse_npm_view_version(&result.stdout))
        }
        .boxed_local()
    })
}

pub fn parse_npm_view_version(output: &str) -> Option<String> {
    let parsed: Value = json::from_str(output).ok()?;
    match parsed.as_array().map(Vec::as_slice) {
        Some([version]) => version.as_str().map(str::to_owned),
        _ => parsed.as_str().map(str::to_owned),
    }
}

async fn fetch_npm_registry_version(package_name: &str) -> Option<String> {
    let encoded = encode_uri_component(package_name);
    let body = fetch_with_timeout(
        &format!("{NPM_REGISTRY_URL}/{encoded}/latest"),
        Some("application/json"),
    )
    .await?;
    let body: Value = json::from_str(&body).ok()?;
    body.get("version")?.as_str().map(str::to_owned)
}

fn encode_uri_component(value: &str) -> String {
    use std::fmt::Write;
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            encoded.push(char::from(byte));
        } else {
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

pub fn homebrew_latest_version(
    brew: String,
    name: String,
    cask: bool,
    env: Environment,
) -> LatestVersionLookup {
    Box::new(move || {
        async move {
            let mut args = vec!["info".into(), "--json=v2".into()];
            if cask {
                args.push("--cask".into());
            }
            args.push(name);
            let result = run_bounded_command(&brew, &args, lookup_options(&env)).await?;
            if result.exit_code != Some(0) || result.truncated {
                return Ok(None);
            }
            Ok(parse_homebrew_info_version(&result.stdout, cask))
        }
        .boxed_local()
    })
}

fn lookup_options(env: &Environment) -> BoundedCommandOptions<'_> {
    BoundedCommandOptions {
        env,
        timeout: TOOL_LOOKUP_TIMEOUT,
        max_output_bytes: TOOL_LOOKUP_MAX_BYTES,
        on_line: None,
    }
}

pub fn parse_homebrew_info_version(output: &str, cask: bool) -> Option<String> {
    let info: Value = json::from_str(output).ok()?;
    let raw = if cask {
        &first_entry(info.get("casks")?)?["version"]
    } else {
        &first_entry(info.get("formulae")?)?["versions"]["stable"]
    };
    let raw = raw.as_str()?;
    Some(
        raw.split_once(',')
            .map_or(raw, |(version, _)| version)
            .to_owned(),
    )
}

fn first_entry(value: &Value) -> Option<&Value> {
    value.get(0).or_else(|| value.get("0"))
}

pub fn channel_latest_version(
    url: String,
    parse: fn(&str) -> Option<String>,
) -> LatestVersionLookup {
    Box::new(move || {
        async move {
            Ok(fetch_with_timeout(&url, None)
                .await
                .as_deref()
                .and_then(parse))
        }
        .boxed_local()
    })
}

async fn fetch_with_timeout(url: &str, accept: Option<&str>) -> Option<String> {
    static CLIENT: OnceCell<reqwest::Client> = OnceCell::const_new();
    let client = CLIENT
        .get_or_try_init(|| async {
            let tls = garcon_base::tls_roots::verified_client_config()?;
            let client = reqwest::Client::builder()
                .use_preconfigured_tls(tls)
                .http1_only()
                .timeout(LOOKUP_TIMEOUT)
                .redirect(reqwest::redirect::Policy::limited(20))
                .retry(reqwest::retry::never())
                .build()?;
            Ok::<_, Box<dyn std::error::Error + Send + Sync>>(client)
        })
        .await
        .ok()?;
    let mut request = client.get(url);
    if let Some(accept) = accept {
        request = request.header(reqwest::header::ACCEPT, accept);
    }
    let response = request.send().await.ok()?.error_for_status().ok()?;
    if !response.status().is_success() {
        return None;
    }
    let bytes = response.bytes().await.ok()?;
    let text = String::from_utf8_lossy(&bytes);
    Some(text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned())
}
