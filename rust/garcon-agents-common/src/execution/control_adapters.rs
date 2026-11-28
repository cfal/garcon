//! Ports `server-agents/common/src/execution/control-adapters.ts`.

use std::{cell::RefCell, rc::Rc, time::Duration};

use async_trait::async_trait;
use garcon_interface::{
    resources::{ExecutorCallOptions, ExecutorResult},
    services::{
        AgentSteerRejectionReason, AgentSteerRequest, AgentSteerResult, AgentSteerTarget,
        AgentSteerTargetKind, AgentSteerTargetRequest, AgentSteering,
    },
};
use tokio::{
    task::{JoinHandle, spawn_local},
    time::sleep_until,
};

use super::{
    admission::check_options,
    producer_adapter::{AgentProducerAdapter, Operation},
    resource_table::{AgentResourceTable, stale},
    runtime_events::{PrepareDelivery, RuntimeSteerRequest, RuntimeSteerTarget},
};

const PREPARATION_TIMEOUT: Duration = Duration::from_secs(30);

#[async_trait(?Send)]
pub trait RuntimeSteering {
    fn capture_target(&self, agent_session_id: &str) -> Option<RuntimeSteerTarget>;
    async fn steer(&self, request: RuntimeSteerRequest) -> ExecutorResult<AgentSteerResult>;
}

struct CapturedTarget {
    operation: Rc<Operation>,
    target: RuntimeSteerTarget,
    timer: RefCell<Option<JoinHandle<()>>>,
}

impl CapturedTarget {
    fn clear_timer(&self) {
        if let Some(timer) = self.timer.take() {
            timer.abort();
        }
    }
}

impl Drop for CapturedTarget {
    fn drop(&mut self) {
        self.clear_timer();
    }
}

struct Steering {
    producer: Rc<AgentProducerAdapter>,
    runtime: Rc<dyn RuntimeSteering>,
    targets: Rc<AgentResourceTable<AgentSteerTargetKind, Rc<CapturedTarget>>>,
    new_id: Rc<dyn Fn() -> String>,
}

pub fn create_agent_steering(
    producer: Rc<AgentProducerAdapter>,
    runtime: Rc<dyn RuntimeSteering>,
    new_id: Rc<dyn Fn() -> String>,
) -> Rc<dyn AgentSteering> {
    use garcon_interface::producer::AgentProducers;
    let targets = Rc::new(AgentResourceTable::new(
        producer.scope().clone(),
        AgentSteerTargetKind::SteerTarget,
        256,
    ));
    Rc::new(Steering {
        producer,
        runtime,
        targets,
        new_id,
    })
}

#[async_trait(?Send)]
impl AgentSteering for Steering {
    async fn capture_target(
        &self,
        request: AgentSteerTargetRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Option<AgentSteerTarget>> {
        check_options(options.as_ref())?;
        let Some(operation) = self.producer.expected_operation(&request)? else {
            return Ok(None);
        };
        let Some(target) = self.runtime.capture_target(&request.agent_session_id) else {
            return Ok(None);
        };
        let captured = Rc::new(CapturedTarget {
            operation,
            target,
            timer: RefCell::default(),
        });
        let reference = self.targets.add(captured.clone(), self.new_id.as_ref())?;
        let deadline = tokio::time::Instant::now() + PREPARATION_TIMEOUT;
        let targets = Rc::downgrade(&self.targets);
        let expiry = reference.clone();
        captured.timer.replace(Some(spawn_local(async move {
            sleep_until(deadline).await;
            if let Some(targets) = targets.upgrade() {
                let _ = targets.delete(&expiry);
            }
        })));
        Ok(Some(reference))
    }

    async fn steer(
        &self,
        request: AgentSteerRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<AgentSteerResult> {
        check_options(options.as_ref())?;
        let Some(reference) = request.target else {
            return Ok(AgentSteerResult::Rejected {
                reason: AgentSteerRejectionReason::NoActiveTurn,
                message: "No active turn".to_owned(),
            });
        };
        let captured = self.targets.take(&reference)?;
        captured.clear_timer();
        if !captured
            .operation
            .matches_target(&request.chat_id, &request.agent_session_id)
        {
            return Err(stale("Steering resource mismatch").into());
        }
        self.producer.assert_current(&captured.operation)?;
        let prepare_delivery: PrepareDelivery = Rc::new({
            let producer = self.producer.clone();
            let operation = captured.operation.clone();
            move || {
                let (producer, operation, options) =
                    (producer.clone(), operation.clone(), options.clone());
                Box::pin(async move {
                    check_options(options.as_ref())?;
                    producer.assert_current(&operation)
                })
            }
        });
        self.runtime
            .steer(RuntimeSteerRequest {
                question_reply: request.question_reply,
                chat_id: request.chat_id,
                project_path: request.project_path,
                agent_session_id: request.agent_session_id,
                native_session: request.native_session,
                target: Some(captured.target.clone()),
                input: request.input,
                client_message_id: request.client_message_id,
                prepare_delivery,
            })
            .await
    }
}
