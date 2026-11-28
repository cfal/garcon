//! Ports the endpoint router and fingerprint from `server-agents/common/src/direct/router.ts`.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use async_trait::async_trait;
use futures::future::LocalBoxFuture;
use garcon_contract::api_providers::ApiProtocol;
use garcon_interface::execution::AgentRunningSession;
use garcon_interface::resources::ExecutorResult;
use garcon_js::{collation::Collation, json};
use indexmap::IndexMap;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::shared::provider_http::ProviderHttpEndpoint;

use super::anthropic_compatible_chat_runtime::{
    AnthropicCompatibleChatProtocol, run_anthropic_compatible_single_query,
};
use super::direct_chat_runtime_base::{
    DirectChatProtocol, DirectChatRuntimeBase, DirectChatRuntimeBaseConfig,
};
use super::openai_compatible_chat_runtime::{
    OpenAiCompatibleChatProtocol, run_open_ai_compatible_single_query,
};
use super::openai_compatible_responses_runtime::{
    OpenAiCompatibleResponsesProtocol, run_open_ai_responses_single_query,
};
use super::runtime_types::{
    DirectEndpointRuntime, DirectResumeRequest, DirectStartRequest, DirectStartedSession,
};
use super::session_store::DirectSessionStore;
use super::single_query_options::DirectSingleQueryOptions;

#[async_trait(?Send)]
pub trait DirectCompatibleRuntime {
    async fn start_session(
        &self,
        request: DirectStartRequest,
    ) -> ExecutorResult<DirectStartedSession>;
    async fn run_turn(&self, request: DirectResumeRequest) -> ExecutorResult<()>;
    fn abort(&self, agent_session_id: &str) -> bool;
    fn is_running(&self, agent_session_id: &str) -> bool;
    fn forget_session(&self, agent_session_id: &str) -> ExecutorResult<()>;
    fn get_running_sessions(&self) -> Vec<AgentRunningSession>;
    fn start_purge_timer(&self);
    fn shutdown(&self);
}

#[async_trait(?Send)]
impl<P: DirectChatProtocol + 'static> DirectCompatibleRuntime for DirectChatRuntimeBase<P> {
    async fn start_session(
        &self,
        request: DirectStartRequest,
    ) -> ExecutorResult<DirectStartedSession> {
        Self::start_session(self, request).await
    }
    async fn run_turn(&self, request: DirectResumeRequest) -> ExecutorResult<()> {
        Self::run_turn(self, request).await
    }
    fn abort(&self, id: &str) -> bool {
        Self::abort(self, id)
    }
    fn is_running(&self, id: &str) -> bool {
        Self::is_running(self, id)
    }
    fn forget_session(&self, id: &str) -> ExecutorResult<()> {
        Self::forget_session(self, id)
    }
    fn get_running_sessions(&self) -> Vec<AgentRunningSession> {
        Self::get_running_sessions(self)
    }
    fn start_purge_timer(&self) {
        Self::start_purge_timer(self);
    }
    fn shutdown(&self) {
        Self::shutdown(self);
    }
}

pub type CreateRuntime<R> = Box<dyn Fn(&DirectEndpointRuntime) -> ExecutorResult<R>>;
pub type RunSingleQuery = Box<
    dyn Fn(
        String,
        DirectEndpointRuntime,
        DirectSingleQueryOptions,
    ) -> LocalBoxFuture<'static, ExecutorResult<String>>,
>;

pub struct DirectEndpointRouterConfig<R> {
    pub label: String,
    pub protocol: ApiProtocol,
    pub create_runtime: CreateRuntime<R>,
    pub run_single_query: RunSingleQuery,
}

pub struct DirectEndpointRouterRuntime<R> {
    config: DirectEndpointRouterConfig<R>,
    runtimes: RefCell<IndexMap<String, Rc<R>>>,
    session_runtime_keys: RefCell<IndexMap<String, String>>,
    purge_timers_started: Cell<bool>,
}

impl<R: DirectCompatibleRuntime> DirectEndpointRouterRuntime<R> {
    pub fn new(config: DirectEndpointRouterConfig<R>) -> Self {
        Self {
            config,
            runtimes: RefCell::default(),
            session_runtime_keys: RefCell::default(),
            purge_timers_started: Cell::new(false),
        }
    }

    pub async fn start_session(
        &self,
        request: DirectStartRequest,
    ) -> ExecutorResult<DirectStartedSession> {
        let key = direct_endpoint_fingerprint(&request.execution.endpoint);
        let runtime = self.runtime_for(&request.execution.endpoint, &key)?;
        let started = runtime.start_session(request).await?;
        self.session_runtime_keys
            .borrow_mut()
            .insert(started.agent_session_id.clone(), key);
        Ok(started)
    }

    pub async fn run_turn(&self, request: DirectResumeRequest) -> ExecutorResult<()> {
        let key = direct_endpoint_fingerprint(&request.execution.endpoint);
        let previous = self
            .session_runtime_keys
            .borrow()
            .get(&request.agent_session_id)
            .cloned();
        if let Some(previous) = previous.filter(|previous| !previous.is_empty() && *previous != key)
        {
            let runtime = self.runtimes.borrow().get(&previous).cloned();
            if let Some(runtime) = runtime {
                runtime.forget_session(&request.agent_session_id)?;
            }
        }
        let runtime = self.runtime_for(&request.execution.endpoint, &key)?;
        self.session_runtime_keys
            .borrow_mut()
            .insert(request.agent_session_id.clone(), key);
        runtime.run_turn(request).await
    }

    pub fn abort(&self, id: &str) -> bool {
        self.runtime_for_session(id)
            .is_some_and(|runtime| runtime.abort(id))
    }

    pub fn is_running(&self, id: &str) -> bool {
        self.runtime_for_session(id)
            .is_some_and(|runtime| runtime.is_running(id))
    }

    pub fn get_running_sessions(&self) -> Vec<AgentRunningSession> {
        let runtimes = self.runtimes.borrow().values().cloned().collect::<Vec<_>>();
        runtimes
            .iter()
            .flat_map(|runtime| runtime.get_running_sessions())
            .collect()
    }

    pub async fn run_single_query(
        &self,
        prompt: String,
        endpoint: DirectEndpointRuntime,
        options: DirectSingleQueryOptions,
    ) -> ExecutorResult<String> {
        self.validate_endpoint(&endpoint)?;
        (self.config.run_single_query)(prompt, endpoint, options).await
    }

    pub fn start_purge_timer(&self) {
        if self.purge_timers_started.replace(true) {
            return;
        }
        let runtimes = self.runtimes.borrow().values().cloned().collect::<Vec<_>>();
        for runtime in runtimes {
            runtime.start_purge_timer();
        }
    }

    pub fn shutdown(&self) {
        self.purge_timers_started.set(false);
        let runtimes = self.runtimes.borrow().values().cloned().collect::<Vec<_>>();
        for runtime in runtimes {
            runtime.shutdown();
        }
        self.runtimes.borrow_mut().clear();
        self.session_runtime_keys.borrow_mut().clear();
    }

    fn runtime_for_session(&self, id: &str) -> Option<Rc<R>> {
        if let Some(key) = self.session_runtime_keys.borrow().get(id)
            && let Some(runtime) = self.runtimes.borrow().get(key)
        {
            return Some(runtime.clone());
        }
        let runtimes = self.runtimes.borrow().values().cloned().collect::<Vec<_>>();
        runtimes.into_iter().find(|runtime| runtime.is_running(id))
    }

    fn runtime_for(&self, endpoint: &DirectEndpointRuntime, key: &str) -> ExecutorResult<Rc<R>> {
        self.validate_endpoint(endpoint)?;
        if let Some(runtime) = self.runtimes.borrow().get(key) {
            return Ok(runtime.clone());
        }
        let runtime = Rc::new((self.config.create_runtime)(endpoint)?);
        self.runtimes
            .borrow_mut()
            .insert(key.to_owned(), runtime.clone());
        if self.purge_timers_started.get() {
            runtime.start_purge_timer();
        }
        Ok(runtime)
    }

    fn validate_endpoint(&self, endpoint: &DirectEndpointRuntime) -> ExecutorResult<()> {
        if endpoint.selection.protocol != self.config.protocol {
            return Err(format!(
                "{} does not support {} endpoints",
                self.config.label,
                endpoint.selection.protocol.as_str()
            )
            .into());
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct DirectRuntimeFamilyOptions {
    pub runtime_label: String,
    pub sessions: DirectSessionStore,
}

pub fn create_direct_open_ai_chat_runtime(
    options: DirectRuntimeFamilyOptions,
) -> DirectEndpointRouterRuntime<DirectChatRuntimeBase<OpenAiCompatibleChatProtocol>> {
    let config = options.clone();
    DirectEndpointRouterRuntime::new(DirectEndpointRouterConfig {
        label: options.runtime_label.clone(),
        protocol: ApiProtocol::OpenAiCompatible,
        create_runtime: Box::new(move |endpoint| {
            DirectChatRuntimeBase::new(
                config.base(endpoint),
                OpenAiCompatibleChatProtocol(config.http(endpoint)),
            )
        }),
        run_single_query: Box::new(move |prompt, endpoint, query| {
            let protocol = OpenAiCompatibleChatProtocol(options.http(&endpoint));
            Box::pin(
                async move { run_open_ai_compatible_single_query(&protocol, prompt, query).await },
            )
        }),
    })
}

pub fn create_direct_open_ai_responses_runtime(
    options: DirectRuntimeFamilyOptions,
) -> DirectEndpointRouterRuntime<DirectChatRuntimeBase<OpenAiCompatibleResponsesProtocol>> {
    let config = options.clone();
    DirectEndpointRouterRuntime::new(DirectEndpointRouterConfig {
        label: options.runtime_label.clone(),
        protocol: ApiProtocol::OpenAiCompatible,
        create_runtime: Box::new(move |endpoint| {
            DirectChatRuntimeBase::new(config.base(endpoint), config.responses(endpoint))
        }),
        run_single_query: Box::new(move |prompt, endpoint, query| {
            let protocol = options.responses(&endpoint);
            Box::pin(
                async move { run_open_ai_responses_single_query(&protocol, prompt, query).await },
            )
        }),
    })
}

pub fn create_direct_anthropic_runtime(
    options: DirectRuntimeFamilyOptions,
) -> DirectEndpointRouterRuntime<DirectChatRuntimeBase<AnthropicCompatibleChatProtocol>> {
    let config = options.clone();
    DirectEndpointRouterRuntime::new(DirectEndpointRouterConfig {
        label: options.runtime_label.clone(),
        protocol: ApiProtocol::AnthropicMessages,
        create_runtime: Box::new(move |endpoint| {
            DirectChatRuntimeBase::new(config.base(endpoint), config.anthropic(endpoint))
        }),
        run_single_query: Box::new(move |prompt, endpoint, query| {
            let protocol = options.anthropic(&endpoint);
            Box::pin(async move {
                run_anthropic_compatible_single_query(&protocol, prompt, query).await
            })
        }),
    })
}

impl DirectRuntimeFamilyOptions {
    fn base(&self, endpoint: &DirectEndpointRuntime) -> DirectChatRuntimeBaseConfig {
        DirectChatRuntimeBaseConfig {
            runtime_label: self.runtime_label.clone(),
            default_model: endpoint.selection.model.clone(),
            sessions: self.sessions.clone(),
            max_messages_per_session: None,
        }
    }

    fn http(&self, endpoint: &DirectEndpointRuntime) -> ProviderHttpEndpoint {
        ProviderHttpEndpoint {
            runtime_label: self.runtime_label.clone(),
            default_model: endpoint.selection.model.clone(),
            base_url: endpoint.selection.base_url.clone(),
            credential: endpoint.credential.clone(),
        }
    }

    fn responses(&self, endpoint: &DirectEndpointRuntime) -> OpenAiCompatibleResponsesProtocol {
        OpenAiCompatibleResponsesProtocol {
            endpoint: self.http(endpoint),
            endpoint_id: endpoint.selection.endpoint_id.clone(),
            endpoint_fingerprint: direct_endpoint_fingerprint(endpoint),
        }
    }

    fn anthropic(&self, endpoint: &DirectEndpointRuntime) -> AnthropicCompatibleChatProtocol {
        AnthropicCompatibleChatProtocol {
            endpoint: self.http(endpoint),
            max_tokens: None,
        }
    }
}

pub fn direct_endpoint_fingerprint(endpoint: &DirectEndpointRuntime) -> String {
    let selection = &endpoint.selection;
    let mut headers = selection
        .headers
        .iter()
        .map(|(name, value)| (name.to_lowercase(), value))
        .collect::<Vec<_>>();
    headers.sort_by(|(left, _), (right, _)| Collation::english().compare(left, right));
    let route = json!({
        "endpointId": selection.endpoint_id,
        "protocol": selection.protocol,
        "baseUrl": selection.base_url.trim_end_matches('/'),
        "headersDigest": digest(&json::stringify(&json!(headers))),
        "credentialDigest": digest(endpoint.credential.as_deref().unwrap_or_default()),
    });
    digest(&json::stringify(&route))
}

fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

#[cfg(test)]
mod tests;
