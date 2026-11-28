//! Ports `server-agents/common/src/direct/direct-chat-runtime-base.ts`.

use std::cell::RefCell;
use std::rc::Rc;

use async_trait::async_trait;
use garcon_base::errors::{NamedError, error_metadata};
use garcon_contract::agent_execution::AgentAttachment;
use garcon_contract::chat_modes::ThinkingMode;
use garcon_contract::chat_types::{AssistantMessage, ChatMessage};
use garcon_interface::execution::AgentRunningSession;
use garcon_interface::native_message_source::NativeSourced;
use garcon_interface::producer::{AgentFinalResponse, AgentRunFailureDetail};
use garcon_interface::resources::ExecutorResult;
use garcon_js::clock::{Clock, SystemClock};
use garcon_js::{to_iso_string, trim};
use indexmap::IndexMap;
use tokio::task::spawn_local;
use tokio_util::sync::CancellationToken;

use crate::execution::runtime_events::{
    AgentRuntimeEvent, AgentRuntimeOperation, ProviderRunOutcome, runtime_rows,
};
use crate::shared::idle_session_purger::{
    DEFAULT_IDLE_SESSION_MAX_AGE_MS, DEFAULT_IDLE_SESSION_PURGE_INTERVAL_MS, IdleSessionPurger,
    purge_idle_sessions,
};

use super::native_session::{direct_session_unavailable, load_direct_session_required};
use super::runtime_types::{
    DirectExecutionRequest, DirectResumeRequest, DirectStartRequest, DirectStartedSession,
    assert_direct_execution_open, mark_direct_execution_started,
};
use super::session_store::{
    DirectAssistantInput, DirectResponsesCheckpointV1, DirectSessionRecordV1, DirectSessionStore,
    DirectUserInput,
};

const DEFAULT_MAX_MESSAGES_PER_SESSION: usize = 200;

type Session<T> = Rc<RefCell<DirectRuntimeSession<T>>>;
type Sessions<T> = IndexMap<String, Session<T>>;

struct DirectRuntimeSession<T> {
    abort_controller: Option<CancellationToken>,
    aborted: bool,
    history: Vec<DirectSessionRecordV1>,
    history_needs_refresh: bool,
    id: String,
    is_finalizing: bool,
    is_running: bool,
    messages: Rc<[T]>,
    model: String,
    thinking_mode: ThinkingMode,
    start_time: i64,
    last_activity_at: i64,
    operation: AgentRuntimeOperation,
}

impl<T> DirectRuntimeSession<T> {
    fn mark_idle(&mut self) {
        if self.is_running {
            self.is_running = false;
            self.last_activity_at = SystemClock.now_ms();
        }
    }

    fn mark_running(&mut self) {
        if !self.is_running {
            self.is_running = true;
            self.is_finalizing = false;
            self.aborted = false;
            self.last_activity_at = SystemClock.now_ms();
        }
    }

    fn stream_view(&mut self) -> DirectStreamSession<T> {
        let abort = CancellationToken::new();
        self.abort_controller = Some(abort.clone());
        let previous_checkpoint = self
            .history
            .iter()
            .nth_back(1)
            .and_then(|record| match record {
                DirectSessionRecordV1::Assistant(record) => record.checkpoint.clone(),
                DirectSessionRecordV1::User(_) => None,
            });
        DirectStreamSession {
            model: self.model.clone(),
            thinking_mode: self.thinking_mode,
            messages: self.messages.clone(),
            previous_checkpoint,
            signal: abort,
        }
    }
}

pub struct DirectStreamSession<T> {
    pub model: String,
    pub thinking_mode: ThinkingMode,
    pub messages: Rc<[T]>,
    pub previous_checkpoint: Option<DirectResponsesCheckpointV1>,
    pub signal: CancellationToken,
}

pub struct DirectTurnCompletion {
    pub content: String,
    pub checkpoint: Option<DirectResponsesCheckpointV1>,
}

pub struct DirectChatRuntimeBaseConfig {
    pub runtime_label: String,
    pub default_model: String,
    pub sessions: DirectSessionStore,
    pub max_messages_per_session: Option<usize>,
}

#[async_trait(?Send)]
pub trait DirectChatProtocol {
    type Message: 'static;

    fn build_user_message(&self, command: &str, attachments: &[AgentAttachment]) -> Self::Message;
    fn build_assistant_message(&self, content: &str) -> Self::Message;
    async fn stream_session(
        &self,
        session: DirectStreamSession<Self::Message>,
    ) -> ExecutorResult<DirectTurnCompletion>;
}

struct Runtime<P: DirectChatProtocol> {
    config: DirectChatRuntimeBaseConfig,
    protocol: P,
    max_messages: usize,
    sessions: RefCell<Sessions<P::Message>>,
    idle_purger: IdleSessionPurger,
}

pub struct DirectChatRuntimeBase<P: DirectChatProtocol>(Rc<Runtime<P>>);

impl<P: DirectChatProtocol + 'static> DirectChatRuntimeBase<P> {
    pub fn new(config: DirectChatRuntimeBaseConfig, protocol: P) -> ExecutorResult<Self> {
        let max_messages = config
            .max_messages_per_session
            .unwrap_or(DEFAULT_MAX_MESSAGES_PER_SESSION);
        if !(2..=9_007_199_254_740_991_u64).contains(&(max_messages as u64)) {
            return Err(NamedError {
                name: "TypeError".into(),
                message: "Direct runtime message limit must be at least two".into(),
                code: None,
            }
            .into());
        }
        Ok(Self(Rc::new(Runtime {
            config,
            protocol,
            max_messages,
            sessions: RefCell::default(),
            idle_purger: IdleSessionPurger::default(),
        })))
    }

    pub async fn start_session(
        &self,
        mut request: DirectStartRequest,
    ) -> ExecutorResult<DirectStartedSession> {
        assert_direct_execution_open(&request.execution)?;
        let store = &self.0.config.sessions;
        let id = store.create_session_id();
        let snapshot = store
            .create(user_input(&id, &mut request.execution))
            .await?;
        if let Err(error) = assert_direct_execution_open(&request.execution) {
            let _ = store.delete(&id).await;
            return Err(error);
        }
        let session = self.create_runtime_session(id.clone(), &request.execution, snapshot.records);
        self.0
            .sessions
            .borrow_mut()
            .insert(id.clone(), session.clone());
        let started = DirectStartedSession {
            native_session: store.native_reference(&id)?,
            agent_session_id: id,
        };
        if let Some(on_session_activated) = request.on_session_activated {
            on_session_activated(&started)?;
        }
        let owner = Self(self.0.clone());
        let mut turn = Box::pin(async move {
            let _ = owner.run_turn_internal(&session, &request.execution).await;
        });
        // Native admission begins before publishing the asynchronous start reply.
        if futures::poll!(&mut turn).is_pending() {
            spawn_local(turn);
        }
        Ok(started)
    }

    pub async fn run_turn(&self, mut request: DirectResumeRequest) -> ExecutorResult<()> {
        assert_direct_execution_open(&request.execution)?;
        let captured = self
            .0
            .sessions
            .borrow()
            .get(&request.agent_session_id)
            .cloned();
        let session = match captured {
            Some(session) => session,
            None => {
                let records = self.load_required(&request).await?;
                let session = self.create_runtime_session(
                    request.agent_session_id.clone(),
                    &request.execution,
                    records,
                );
                self.0
                    .sessions
                    .borrow_mut()
                    .insert(request.agent_session_id.clone(), session.clone());
                session
            }
        };
        assert_direct_execution_open(&request.execution)?;
        let refresh = {
            let mut session = session.borrow_mut();
            if session.is_running {
                return Err(already_running(&request.agent_session_id));
            }
            if !request.execution.model.is_empty() {
                session.model.clone_from(&request.execution.model);
            }
            session.thinking_mode = request.execution.thinking_mode;
            session.operation = request.execution.operation.clone();
            session.mark_running();
            session.history_needs_refresh
        };
        let result = async {
            if refresh {
                let records = self.load_required(&request).await?;
                {
                    let mut session = session.borrow_mut();
                    session.messages = self.project_messages(&records);
                    session.history = records;
                    session.history_needs_refresh = false;
                }
                assert_direct_execution_open(&request.execution)?;
            }
            let user = self.append_user(&mut request).await?;
            {
                let mut session = session.borrow_mut();
                session.history.push(DirectSessionRecordV1::User(user));
                session.messages = self.project_messages(&session.history);
            }
            self.mark_replacement_history_stale(&request.agent_session_id, &session);
            assert_direct_execution_open(&request.execution)?;
            self.run_turn_internal(&session, &request.execution).await
        }
        .await;
        if result.is_err() {
            session.borrow_mut().mark_idle();
        }
        result
    }

    pub fn abort(&self, id: &str) -> bool {
        let current = self.0.sessions.borrow().get(id).cloned();
        let Some(current) = current else { return false };
        let cancel = {
            let mut session = current.borrow_mut();
            if !session.is_running || session.is_finalizing {
                return false;
            }
            session.aborted = true;
            session.abort_controller.clone()
        };
        self.0.sessions.borrow_mut().shift_remove(id);
        if let Some(cancel) = cancel {
            cancel.cancel();
        }
        true
    }

    pub fn is_running(&self, id: &str) -> bool {
        self.0
            .sessions
            .borrow()
            .get(id)
            .is_some_and(|session| session.borrow().is_running)
    }

    pub fn forget_session(&self, id: &str) -> ExecutorResult<()> {
        if self.is_running(id) {
            return Err(already_running(id));
        }
        self.0.sessions.borrow_mut().shift_remove(id);
        Ok(())
    }

    pub fn get_running_sessions(&self) -> Vec<AgentRunningSession> {
        self.0
            .sessions
            .borrow()
            .values()
            .filter_map(|session| {
                let session = session.borrow();
                session.is_running.then(|| AgentRunningSession {
                    agent_session_id: session.id.clone(),
                    started_at: to_iso_string(session.start_time).ok(),
                    status: Some("running".into()),
                })
            })
            .collect()
    }

    pub fn start_purge_timer(&self) {
        let owner = Rc::downgrade(&self.0);
        self.0
            .idle_purger
            .start(DEFAULT_IDLE_SESSION_PURGE_INTERVAL_MS, move || {
                let Some(owner) = owner.upgrade() else { return };
                let mut stale_ids = Vec::new();
                purge_idle_sessions(
                    owner.sessions.borrow().iter(),
                    |session| session.borrow().is_running,
                    |session| session.borrow().last_activity_at,
                    |id, _| stale_ids.push(id.clone()),
                    SystemClock.now_ms(),
                    DEFAULT_IDLE_SESSION_MAX_AGE_MS,
                );
                let mut sessions = owner.sessions.borrow_mut();
                for id in stale_ids {
                    sessions.shift_remove(&id);
                }
            });
    }

    pub fn shutdown(&self) {
        self.0.idle_purger.stop();
        let sessions = self.0.sessions.take();
        for (_, session) in sessions {
            let abort = {
                let mut session = session.borrow_mut();
                if session.is_finalizing {
                    continue;
                }
                session.aborted = true;
                session.abort_controller.clone()
            };
            if let Some(abort) = abort {
                abort.cancel();
            }
        }
    }

    async fn load_required(
        &self,
        request: &DirectResumeRequest,
    ) -> ExecutorResult<Vec<DirectSessionRecordV1>> {
        let signal = request
            .execution
            .execution_admission
            .as_ref()
            .map(|admission| admission.signal().clone())
            .unwrap_or_default();
        Ok(load_direct_session_required(
            &self.0.config.sessions,
            &request.agent_session_id,
            request.native_session.as_ref(),
            &signal,
        )
        .await?
        .records)
    }

    fn create_runtime_session(
        &self,
        id: String,
        request: &DirectExecutionRequest,
        history: Vec<DirectSessionRecordV1>,
    ) -> Session<P::Message> {
        let now = SystemClock.now_ms();
        let messages = self.project_messages(&history);
        Rc::new(RefCell::new(DirectRuntimeSession {
            abort_controller: None,
            aborted: false,
            history,
            history_needs_refresh: false,
            id,
            is_finalizing: false,
            is_running: false,
            messages,
            model: if request.model.is_empty() {
                self.0.config.default_model.clone()
            } else {
                request.model.clone()
            },
            thinking_mode: request.thinking_mode,
            start_time: now,
            last_activity_at: now,
            operation: request.operation.clone(),
        }))
    }

    async fn append_user(
        &self,
        request: &mut DirectResumeRequest,
    ) -> ExecutorResult<super::session_store::DirectUserRecordV1> {
        let store = &self.0.config.sessions;
        store
            .session_id_from_reference(
                request.native_session.as_ref(),
                Some(&request.agent_session_id),
            )
            .map_err(|error| direct_session_unavailable(Some(error.as_ref())))?;
        store
            .append_user(user_input(
                &request.agent_session_id,
                &mut request.execution,
            ))
            .await
            .map_err(|error| direct_session_unavailable(Some(error.as_ref())).into())
    }

    fn project_messages(&self, records: &[DirectSessionRecordV1]) -> Rc<[P::Message]> {
        let remove = records.len().saturating_sub(self.0.max_messages);
        records
            .iter()
            .take(1)
            .chain(records.iter().skip(remove + 1))
            .map(|record| match record {
                DirectSessionRecordV1::User(record) => self
                    .0
                    .protocol
                    .build_user_message(&record.content, &record.attachments),
                DirectSessionRecordV1::Assistant(record) => {
                    self.0.protocol.build_assistant_message(&record.content)
                }
            })
            .collect()
    }

    async fn run_turn_internal(
        &self,
        session: &Session<P::Message>,
        request: &DirectExecutionRequest,
    ) -> ExecutorResult<()> {
        let (id, operation, aborted) = {
            let mut session = session.borrow_mut();
            session.mark_running();
            (
                session.id.clone(),
                session.operation.clone(),
                session.aborted,
            )
        };
        if aborted {
            finish_aborted_turn(session, &operation);
            return Ok(());
        }
        let result = self.complete_turn(&id, session, request, &operation).await;
        let aborted = session.borrow().aborted;
        let result = match result {
            Ok(()) => Ok(()),
            Err(_) if aborted => {
                finish_aborted_turn(session, &operation);
                Ok(())
            }
            Err(error) => {
                session.borrow_mut().mark_idle();
                let metadata = error_metadata(error.as_ref());
                finish(
                    &operation,
                    ProviderRunOutcome::Failed {
                        error: Some(AgentRunFailureDetail {
                            code: metadata.code.unwrap_or("PROVIDER_FAILURE").to_owned(),
                            message: Some(error.to_string()),
                        }),
                    },
                );
                Err(error)
            }
        };
        let mut session = session.borrow_mut();
        session.is_finalizing = false;
        session.mark_idle();
        result
    }

    async fn complete_turn(
        &self,
        id: &str,
        session: &Session<P::Message>,
        request: &DirectExecutionRequest,
        operation: &AgentRuntimeOperation,
    ) -> ExecutorResult<()> {
        mark_direct_execution_started(request).await?;
        let stream = session.borrow_mut().stream_view();
        let completion = self.0.protocol.stream_session(stream).await;
        session.borrow_mut().abort_controller = None;
        let DirectTurnCompletion {
            content,
            checkpoint,
        } = completion?;
        if trim(&content).is_empty() {
            session.borrow_mut().mark_idle();
            finish(
                operation,
                ProviderRunOutcome::Failed {
                    error: Some(AgentRunFailureDetail {
                        code: "PROVIDER_FAILURE".into(),
                        message: Some(format!(
                            "Empty response from {}",
                            self.0.config.runtime_label
                        )),
                    }),
                },
            );
            return Ok(());
        }
        session.borrow_mut().is_finalizing = true;
        let assistant = self
            .0
            .config
            .sessions
            .append_assistant(DirectAssistantInput {
                session_id: id.into(),
                run_id: operation.run_id.clone(),
                content: content.clone(),
                checkpoint,
            })
            .await
            .map_err(|error| direct_session_unavailable(Some(error.as_ref())))?;
        let at = assistant.at.clone();
        {
            let mut session = session.borrow_mut();
            session
                .history
                .push(DirectSessionRecordV1::Assistant(assistant));
            session.messages = self.project_messages(&session.history);
        }
        self.mark_replacement_history_stale(id, session);
        (operation.publish)(AgentRuntimeEvent::Rows {
            rows: runtime_rows([NativeSourced::new(ChatMessage::Assistant(
                AssistantMessage {
                    timestamp: at,
                    content: content.clone(),
                    questions: None,
                },
            ))]),
        });
        session.borrow_mut().mark_idle();
        let final_response =
            (!session.borrow().aborted).then_some(AgentFinalResponse::Text { text: content });
        finish(operation, ProviderRunOutcome::Finished { final_response });
        Ok(())
    }

    fn mark_replacement_history_stale(&self, id: &str, session: &Session<P::Message>) {
        let replacement = self.0.sessions.borrow().get(id).cloned();
        if let Some(replacement) =
            replacement.filter(|replacement| !Rc::ptr_eq(replacement, session))
        {
            replacement.borrow_mut().history_needs_refresh = true;
        }
    }
}

fn already_running(id: &str) -> Box<dyn std::error::Error> {
    format!("Session {id} is already running").into()
}

fn user_input(id: &str, request: &mut DirectExecutionRequest) -> DirectUserInput {
    DirectUserInput {
        session_id: id.into(),
        run_id: request.operation.run_id.clone(),
        content: std::mem::take(&mut request.command),
        attachments: request.images.take().unwrap_or_default(),
    }
}

fn finish(operation: &AgentRuntimeOperation, outcome: ProviderRunOutcome) {
    (operation.publish)(AgentRuntimeEvent::RunEnded {
        run_id: operation.run_id.clone(),
        outcome,
        working_directory: None,
    });
}

fn finish_aborted_turn<T>(session: &Session<T>, operation: &AgentRuntimeOperation) {
    session.borrow_mut().mark_idle();
    finish(
        operation,
        ProviderRunOutcome::Finished {
            final_response: None,
        },
    );
}

#[cfg(test)]
mod tests;
