use std::time::Duration;

use garcon_cases::{CaseError, replay, unknown};
use serde_json::{Value, json};
use tokio::task::{LocalSet, yield_now};
use tokio::time::{advance, timeout};

use super::*;
use crate::acp::errors::AcpRpcError;

struct TestSteering;

impl AcpSteeringProtocol for TestSteering {
    fn likely_superseded(&self, result: &AcpSessionPromptResult) -> bool {
        result.get("stopReason").and_then(Value::as_str) == Some("cancelled")
    }

    fn refused(&self, error: &AcpRpcError) -> bool {
        error.has_code(-32001.0)
    }
}

struct Sender {
    sent: Option<SentCallback>,
    reply: ReplyCallback,
    pending: Option<oneshot::Sender<ExecutorResult<AcpSessionPromptResult>>>,
}

#[derive(Default)]
struct Script {
    failure: RefCell<Option<String>>,
    events: RefCell<Vec<Value>>,
    senders: RefCell<Vec<Sender>>,
}

impl Script {
    fn turn(self: &Rc<Self>) -> AcpTurnPrompts {
        AcpTurnPrompts::new(AcpTurnPromptEvents {
            steering: Some(Rc::new(TestSteering)),
            take_failure: Rc::new({
                let script = Rc::clone(self);
                move || Ok(script.failure.borrow_mut().take())
            }),
            on_boundary: Rc::new({
                let script = Rc::clone(self);
                move |failure| {
                    script
                        .events
                        .borrow_mut()
                        .push(json!({"event": "boundary", "failure": failure}));
                    Ok(())
                }
            }),
            on_steerable: Rc::new({
                let script = Rc::clone(self);
                move || {
                    script
                        .events
                        .borrow_mut()
                        .push(json!({"event": "steerable"}))
                }
            }),
        })
    }

    fn capture(
        &self,
        reply: ReplyCallback,
        sent: Option<SentCallback>,
    ) -> impl Future<Output = ExecutorResult<Value>> + use<> {
        let (settle, pending) = oneshot::channel();
        self.senders.borrow_mut().push(Sender {
            sent,
            reply,
            pending: Some(settle),
        });
        async move {
            pending
                .await
                .unwrap_or_else(|_| Err(plain_error("test dropped a prompt")))
        }
    }

    fn reply(&self, index: usize, result: ExecutorResult<Value>) {
        let (callback, pending) = {
            let mut senders = self.senders.borrow_mut();
            let sender = &mut senders[index];
            (Rc::clone(&sender.reply), sender.pending.take())
        };
        let reply = match &result {
            Ok(result) => AcpReply::Result(result),
            Err(error) => AcpReply::Error(error.as_ref()),
        };
        callback(reply).unwrap();
        if let Some(pending) = pending {
            let _ = pending.send(result);
        }
    }

    fn mark_sent(&self, index: usize) {
        let sent = self.senders.borrow()[index].sent.clone().unwrap();
        sent().unwrap();
    }
}

fn position(value: &Value) -> usize {
    usize::try_from(value.as_u64().unwrap()).unwrap()
}

async fn drain_tasks() {
    for _ in 0..8 {
        yield_now().await;
    }
}

async fn script_steps(steps: &[Value]) -> Value {
    let script = Rc::new(Script::default());
    let turn = script.turn();
    let mut release = None;
    for step in steps {
        match step[0].as_str().unwrap() {
            "run" => {
                let capture = Rc::clone(&script);
                let drained = turn.run(move |reply| capture.capture(reply, None));
                let script = Rc::clone(&script);
                spawn_local(async move {
                    let event = match drained.await {
                        Ok(()) => json!({"event": "drained"}),
                        Err(error) => json!({"event": "drained", "error": error.to_string()}),
                    };
                    script.events.borrow_mut().push(event);
                });
            }
            "hold" => {
                let (settle, released) = oneshot::channel();
                release = Some(settle);
                drop(turn.with_steer_slot(move || async move {
                    released.await?;
                    Ok(AgentSteerResult::Accepted)
                }));
            }
            "release" => release.take().unwrap().send(()).unwrap(),
            "steer" => {
                let capture = Rc::clone(&script);
                let decision = turn.steer(move |sent, reply| capture.capture(reply, Some(sent)), step[1].as_f64().unwrap());
                let script = Rc::clone(&script);
                spawn_local(async move {
                    let result = decision.await;
                    script.events.borrow_mut().push(json!({"event": "decision", "result": result}));
                });
            }
            "sent" => script.mark_sent(position(&step[1])),
            "reply" => script.reply(position(&step[1]), Ok(json!({"stopReason": step[2]}))),
            "rpc-error" => script.reply(
                position(&step[1]),
                Err(Box::new(AcpRpcError::new(Some(&step[3]), Some(step[2].clone()), None))),
            ),
            "reject" => {
                let pending = script.senders.borrow_mut()[position(&step[1])].pending.take().unwrap();
                let _ = pending.send(Err(plain_error(step[2].as_str().unwrap())));
            }
            "failure" => {
                script.failure.replace(Some(step[1].as_str().unwrap().to_owned()));
            }
            "tick" => advance(Duration::from_millis(step[1].as_u64().unwrap())).await,
            "snapshot" => script.events.borrow_mut().push(json!({
                "event": "snapshot", "closed": turn.closed(), "awaitingLateReply": turn.awaiting_late_reply(),
            })),
            other => panic!("unknown script step {other}"),
        }
        drain_tasks().await;
    }
    script.senders.borrow_mut().clear();
    let result = script.events.take();
    Value::Array(result)
}

#[test]
fn recorded_acp_turn_prompt_scripts_match() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .start_paused(true)
        .build()
        .unwrap();
    let cases = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/acp-turn-prompts");
    replay(cases, |function, args| {
        if function != "scriptedAcpTurnPrompts" {
            return Err(CaseError::unhandled(function));
        }
        let steps = unknown(function, args.first())?;
        let steps = steps
            .as_array()
            .ok_or_else(|| CaseError::undeliverable("expected an array of prompt script steps"))?;
        let result = runtime.block_on(
            LocalSet::new()
                .run_until(async { timeout(Duration::from_secs(1), script_steps(steps)).await }),
        );
        result.map_err(|error| CaseError::undeliverable(error.to_string()))
    });
}

#[tokio::test(start_paused = true)]
async fn timeout_marks_only_the_pending_overlap_as_late() {
    LocalSet::new()
        .run_until(timeout(Duration::from_secs(1), async {
            let script = Rc::new(Script::default());
            let turn = script.turn();
            let drained = turn.run(|reply| script.capture(reply, None));
            let decision = turn.steer(|sent, reply| script.capture(reply, Some(sent)), 12.0);
            tokio::pin!(decision);
            script.mark_sent(1);
            drain_tasks().await;
            advance(Duration::from_millis(11)).await;
            drain_tasks().await;
            assert!(!turn.awaiting_late_reply());
            assert!(decision.as_mut().now_or_never().is_none());
            advance(Duration::from_millis(1)).await;
            assert_eq!(
                decision.await,
                unconfirmed("The agent did not confirm the steering input within 12ms")
            );
            assert!(turn.awaiting_late_reply());
            script.reply(0, Ok(json!({"stopReason": "cancelled"})));
            assert!(!turn.awaiting_late_reply());
            script.reply(1, Ok(json!({"stopReason": "end_turn"})));
            drained.await.unwrap();
            assert!(turn.closed());
            script.senders.borrow_mut().clear();
        }))
        .await
        .expect("steering test must finish");
}
