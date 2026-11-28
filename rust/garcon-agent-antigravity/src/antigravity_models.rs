//! Ports `agents/antigravity/antigravity-models.ts`.

use std::{collections::HashSet, process::Stdio, rc::Rc, time::Duration};

use futures::future::LocalBoxFuture;
use garcon_agents_common::{
    catalog::model_catalog::ModelCatalog, shared::shared_probe::wait_unless_aborted,
};
use garcon_contract::agents::AgentModelOption;
use garcon_interface::{
    errors::{AgentIntegrationError, AgentIntegrationErrorCode as Code},
    host::AgentLogger,
    resources::ExecutorResult,
};
use garcon_js::{trim, trim_start};
use indexmap::IndexMap;
use tokio::{io::AsyncReadExt, process::Command, time::timeout};

use crate::config::{AntigravityConfig, child_environment, classify_launch_error};

pub const MODELS_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AntigravityCliResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
}

pub async fn run_antigravity_models(
    config: &AntigravityConfig,
    deadline: Duration,
) -> ExecutorResult<AntigravityCliResult> {
    let binary = config.binary()?;
    let env = child_environment(config, &Default::default())?;
    let mut process = Command::new(&binary)
        .arg("models")
        .env_clear()
        .envs(
            env.into_iter()
                .filter_map(|(name, value)| Some((name, value?))),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| classify_launch_error(error.into(), Some(&binary)))?;
    // INFALLIBLE: both streams were configured as pipes above.
    let mut stdout = process.stdout.take().expect("stdout pipe");
    let mut stderr = process.stderr.take().expect("stderr pipe");
    let mut out = Vec::new();
    let mut err = Vec::new();
    // A descendant can keep the pipes open after agy exits.
    let status = timeout(deadline, async {
        let (_, _, status) = tokio::try_join!(
            stdout.read_to_end(&mut out),
            stderr.read_to_end(&mut err),
            async { Ok(process.wait().await.ok()) },
        )?;
        std::io::Result::Ok(status)
    })
    .await
    .map_err(|_| format!("agy models timed out after {} ms", deadline.as_millis()))??;
    Ok(AntigravityCliResult {
        stdout: decode_text(&out),
        stderr: decode_text(&err),
        exit_code: status.and_then(exit_code),
    })
}

fn decode_text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes)).into_owned()
}

fn exit_code(status: std::process::ExitStatus) -> Option<i32> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        status
            .code()
            .or_else(|| status.signal().map(|signal| 128 + signal))
    }
    #[cfg(not(unix))]
    status.code()
}

fn model(value: &str, label: &str) -> AgentModelOption {
    AgentModelOption {
        value: value.into(),
        label: label.into(),
        supports_images: Some(true),
        thinking_modes: None,
        is_local: None,
        api_provider_id: None,
        endpoint_id: None,
        raw_model: None,
        protocol: None,
    }
}

pub fn parse_antigravity_models(output: &str) -> Vec<AgentModelOption> {
    let mut seen = HashSet::new();
    output
        .split('\n')
        .filter_map(|line| {
            let (id, label) = line.split_once('\t')?;
            let id = trim(id);
            if id.is_empty() || !seen.insert(id) {
                return None;
            }
            let label = trim(label);
            Some(model(id, if label.is_empty() { id } else { label }))
        })
        .collect()
}

fn strip_prefix_case_insensitive<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    text.get(..prefix.len())?
        .eq_ignore_ascii_case(prefix)
        .then(|| &text[prefix.len()..])
}

pub fn antigravity_cli_failure(result: &AntigravityCliResult) -> String {
    let output = if result.stderr.is_empty() {
        &result.stdout
    } else {
        &result.stderr
    };
    let detail = output
        .split('\n')
        .map(trim)
        .filter(|line| {
            !line.is_empty()
                && strip_prefix_case_insensitive(line, "Fetching available models").is_none()
        })
        .collect::<Vec<_>>()
        .join(" ");
    let detail =
        strip_prefix_case_insensitive(&detail, "Error:").map_or(detail.as_str(), trim_start);
    let code = result
        .exit_code
        .map_or_else(|| "unknown".to_owned(), |code| code.to_string());
    let status = format!("agy models exited with code {code}");
    if detail.is_empty() {
        status
    } else {
        format!("{status}: {detail}")
    }
}

pub type RunModels = dyn Fn() -> LocalBoxFuture<'static, ExecutorResult<AntigravityCliResult>>;

pub fn create_antigravity_catalog(
    run_models: Rc<RunModels>,
    logger: Rc<dyn AgentLogger>,
) -> ModelCatalog {
    ModelCatalog {
        logger: logger.clone(),
        default_model: "default".into(),
        fallback_models: Vec::new(),
        requires_strict_model_discovery: false,
        generation: None,
        discover: Some(Box::new(move |request| {
            let run_models = run_models.clone();
            let logger = logger.clone();
            Box::pin(async move {
                wait_unless_aborted(
                    get_models(
                        run_models,
                        &*logger,
                        request.require_native_discovery.is_some(),
                    ),
                    Some(&request.signal),
                )
                .await
            })
        })),
    }
}

async fn get_models(
    run_models: Rc<RunModels>,
    logger: &dyn AgentLogger,
    require_native: bool,
) -> ExecutorResult<Vec<AgentModelOption>> {
    let native_default = model("default", "Default");
    let error = match run_models().await {
        Ok(result) if result.exit_code == Some(0) => {
            let mut models = vec![native_default];
            models.extend(parse_antigravity_models(&result.stdout));
            return Ok(models);
        }
        Ok(result) => antigravity_cli_failure(&result).into(),
        Err(error) => error,
    };
    if error
        .downcast_ref::<AgentIntegrationError>()
        .is_some_and(|error| matches!(error.code, Code::BINARY_NOT_FOUND | Code::INVALID_SETTINGS))
    {
        return Err(error);
    }
    if require_native {
        return Err(
            AgentIntegrationError::new(Code::UNAVAILABLE, error.to_string(), true, None).into(),
        );
    }
    logger.warn(
        "Antigravity model discovery failed",
        Some(&IndexMap::from([(
            "error".into(),
            serde_json::Value::from(error.to_string()).into(),
        )])),
    );
    Ok(vec![native_default])
}
