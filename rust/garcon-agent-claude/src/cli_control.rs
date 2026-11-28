use std::{cell::RefCell, error::Error, rc::Rc, time::Duration};

use futures::future::LocalBoxFuture;
use garcon_base::errors::NamedError;
use garcon_interface::resources::ExecutorResult;
use garcon_js::json::Opaque;
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::{Map, Value};
use tokio::{sync::oneshot, task::AbortHandle};
use tokio_util::sync::CancellationToken;

const DEFAULT_CONTROL_TIMEOUT: Duration = Duration::from_secs(10);

pub type ControlWriter = dyn Fn(String, String) -> LocalBoxFuture<'static, ExecutorResult<()>>;
pub type CancellationError = dyn Fn() -> Box<dyn Error>;

#[derive(Default)]
pub struct ClaudeControlRequestOptions {
    pub timeout: Option<Duration>,
    pub signal: Option<CancellationToken>,
    pub cancellation_error: Option<Rc<CancellationError>>,
}

struct PendingControlRequest {
    agent_session_id: String,
    subtype: String,
    response: oneshot::Sender<ExecutorResult<Opaque>>,
    timeout: AbortHandle,
    signal: Option<CancellationToken>,
    cancellation_error: Option<Rc<CancellationError>>,
}

impl PendingControlRequest {
    fn cancelled(&self) -> bool {
        self.signal
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
    }

    fn respond(self, result: ExecutorResult<Opaque>) {
        let result = if self.cancelled() {
            Err(control_cancellation_error(
                self.cancellation_error.as_deref(),
            ))
        } else {
            result
        };
        let _ = self.response.send(result);
    }
}

#[derive(Default)]
struct PendingControls(RefCell<IndexMap<String, PendingControlRequest>>);

impl PendingControls {
    fn take(&self, request_id: &str) -> Option<PendingControlRequest> {
        let pending = self.0.borrow_mut().shift_remove(request_id)?;
        pending.timeout.abort();
        Some(pending)
    }
}

pub struct ClaudeControlBroker {
    pending: Rc<PendingControls>,
    write: Rc<ControlWriter>,
    new_request_id: Rc<dyn Fn() -> String>,
}

impl ClaudeControlBroker {
    pub fn new(write: Rc<ControlWriter>) -> Self {
        Self::with_request_ids(write, || uuid::Uuid::new_v4().to_string())
    }

    pub fn with_request_ids(
        write: Rc<ControlWriter>,
        new_request_id: impl Fn() -> String + 'static,
    ) -> Self {
        Self {
            pending: Rc::default(),
            write,
            new_request_id: Rc::new(new_request_id),
        }
    }

    pub fn request(
        &self,
        agent_session_id: &str,
        request: Opaque,
        options: ClaudeControlRequestOptions,
    ) -> LocalBoxFuture<'static, ExecutorResult<Opaque>> {
        let request_id = (self.new_request_id)();
        let subtype = request["subtype"].as_str().unwrap_or("unknown").to_owned();
        let timeout = options.timeout.unwrap_or(DEFAULT_CONTROL_TIMEOUT);
        if options
            .signal
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
        {
            return Box::pin(async move {
                Err(control_cancellation_error(
                    options.cancellation_error.as_deref(),
                ))
            });
        }

        #[derive(Serialize)]
        struct Frame<'a> {
            #[serde(rename = "type")]
            kind: &'static str,
            request_id: &'a str,
            request: Opaque,
        }
        let frame = match serde_json::to_string(&Frame {
            kind: "control_request",
            request_id: &request_id,
            request,
        }) {
            Ok(frame) => frame,
            Err(error) => return Box::pin(async move { Err(error.into()) }),
        };

        let (response, result) = oneshot::channel();
        let pending = Rc::downgrade(&self.pending);
        let expiry_id = request_id.clone();
        let deadline = tokio::time::sleep(timeout);
        let signal = options.signal.clone();
        let abort = tokio::task::spawn_local(async move {
            let cancellation = async {
                if let Some(signal) = &signal {
                    signal.cancelled().await;
                } else {
                    std::future::pending::<()>().await;
                }
            };
            tokio::select! { biased; () = cancellation => {}, () = deadline => {} }
            if let Some(pending) = pending
                .upgrade()
                .and_then(|pending| pending.take(&expiry_id))
            {
                let error = format!("Claude CLI {} control request timed out", pending.subtype);
                pending.respond(Err(error.into()));
            }
        });
        self.pending.0.borrow_mut().insert(
            request_id.clone(),
            PendingControlRequest {
                agent_session_id: agent_session_id.to_owned(),
                subtype,
                response,
                timeout: abort.abort_handle(),
                signal: options.signal.clone(),
                cancellation_error: options.cancellation_error.clone(),
            },
        );

        let written = (self.write)(agent_session_id.to_owned(), frame);
        let pending = Rc::downgrade(&self.pending);
        tokio::task::spawn_local(async move {
            if let Err(error) = written.await
                && let Some(pending) = pending
                    .upgrade()
                    .and_then(|pending| pending.take(&request_id))
            {
                pending.respond(Err(error));
            }
        });
        Box::pin(async move { result.await? })
    }

    pub fn handle_response(&self, agent_session_id: &str, message: &Value) -> bool {
        let response = &message["response"];
        let Some(request_id) = response["request_id"].as_str().filter(|id| !id.is_empty()) else {
            return false;
        };
        if !self
            .pending
            .0
            .borrow()
            .get(request_id)
            .is_some_and(|pending| pending.agent_session_id == agent_session_id)
        {
            return false;
        }
        let Some(pending) = self.pending.take(request_id) else {
            return false;
        };
        let cancelled = pending.cancelled();
        let result = match response["subtype"].as_str() {
            Some("success") => Ok(response
                .get("response")
                .filter(|value| !value.is_null())
                .cloned()
                .unwrap_or_else(|| Value::Object(Map::new()))
                .into()),
            Some("error") => Err(response["error"]
                .as_str()
                .filter(|message| !message.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("Claude CLI {} control request failed", pending.subtype))
                .into()),
            _ => Err(format!(
                "Claude CLI {} control request returned an invalid response",
                pending.subtype
            )
            .into()),
        };
        pending.respond(result);
        !cancelled
    }

    pub fn reject_session(&self, agent_session_id: &str, reason: &str, subtype: Option<&str>) {
        let ids: Vec<_> = self
            .pending
            .0
            .borrow()
            .iter()
            .filter(|(_, request)| {
                request.agent_session_id == agent_session_id
                    && subtype.is_none_or(|subtype| request.subtype == subtype)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            if let Some(pending) = self.pending.take(&id) {
                pending.respond(Err(reason.to_owned().into()));
            }
        }
    }

    pub fn shutdown(&self, reason: &str) {
        for (_, pending) in self.pending.0.take() {
            pending.timeout.abort();
            pending.respond(Err(reason.to_owned().into()));
        }
    }
}

fn control_cancellation_error(make_error: Option<&CancellationError>) -> Box<dyn Error> {
    make_error.map_or_else(
        || {
            Box::new(NamedError {
                name: "AbortError".to_owned(),
                message: "The operation was aborted.".to_owned(),
                code: None,
            }) as Box<dyn Error>
        },
        |make_error| make_error(),
    )
}

#[cfg(test)]
mod tests;
