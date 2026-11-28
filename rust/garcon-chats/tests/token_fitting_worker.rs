use std::{
    process::Command,
    sync::{Arc, mpsc},
    thread::{self, ThreadId},
};

use garcon_chats::{
    task_worker::{TaskWorker, TaskWorkerError},
    token_fitting::{
        carryover::CompactionDestination,
        client::{TokenFitting, TokenFittingWorker},
    },
};
use garcon_contract::{chat_types::parse_chat_messages, error_codes::ErrorCode};
use garcon_js::json;
use serde_json::Value;
use tokio::{sync::oneshot, task::LocalSet};
use tokio_util::sync::CancellationToken;

enum Job {
    Block {
        entered: oneshot::Sender<ThreadId>,
        release: mpsc::Receiver<()>,
    },
    Work(u8),
    Fail,
    Exit,
}

fn worker() -> TaskWorker<Job, (u8, ThreadId), std::io::Error> {
    TaskWorker::new("test", "Token fitting", |job, _| {
        let thread_id = thread::current().id();
        let value = match job {
            Job::Block { entered, release } => {
                let _ = entered.send(thread_id);
                let _ = release.recv();
                0
            }
            Job::Work(value) => value,
            Job::Fail => return Err(std::io::Error::other("synthetic task failure")),
            Job::Exit => panic!("synthetic worker loss"),
        };
        Ok((value, thread_id))
    })
}

fn blocked_job() -> (Job, oneshot::Receiver<ThreadId>, mpsc::Sender<()>) {
    let (notify, entered) = oneshot::channel();
    let (release, receiver) = mpsc::channel();
    (
        Job::Block {
            entered: notify,
            release: receiver,
        },
        entered,
        release,
    )
}

#[tokio::test]
async fn bounds_queued_tasks_and_releases_an_aborted_waiting_slot() {
    LocalSet::new()
        .run_until(async {
            let worker = worker();
            let (blocked, entered, release) = blocked_job();
            let running = worker.run(blocked, None);
            let running_thread = entered.await.unwrap();
            assert_ne!(running_thread, thread::current().id());
            let abort = CancellationToken::new();
            let cancelled = worker.run(Job::Work(100), Some(&abort));
            let waiters: Vec<_> = (1..=7)
                .map(|value| worker.run(Job::Work(value), None))
                .collect();
            let err = worker.run(Job::Work(101), None).await.unwrap_err();
            let domain = err.domain_error().unwrap();
            assert_eq!(domain.code, ErrorCode::TRANSCRIPT_WORK_BUSY);
            assert_eq!(domain.status, 503);
            assert!(domain.retryable);
            abort.cancel();
            let replacement = worker.run(Job::Work(8), None);
            assert!(matches!(cancelled.await, Err(TaskWorkerError::Aborted(_))));
            release.send(()).unwrap();
            assert_eq!(running.await.unwrap(), (0, running_thread));
            for (index, waiting) in waiters.into_iter().enumerate() {
                assert_eq!(waiting.await.unwrap(), ((index + 1) as u8, running_thread));
            }
            assert_eq!(replacement.await.unwrap(), (8, running_thread));
            worker.close();
        })
        .await;
}

#[tokio::test]
async fn abandons_an_aborted_running_task_and_serves_the_next_task_from_a_fresh_worker() {
    LocalSet::new()
        .run_until(async {
            let worker = worker();
            let abort = CancellationToken::new();
            let (blocked, entered, release) = blocked_job();
            let running = worker.run(blocked, Some(&abort));
            let old = entered.await.unwrap();
            let next = worker.run(Job::Work(7), None);
            abort.cancel();
            assert!(matches!(running.await, Err(TaskWorkerError::Aborted(_))));
            release.send(()).unwrap();
            let (value, new) = next.await.unwrap();
            assert_eq!(value, 7);
            assert_ne!(old, new, "cancelled worker must not run the next task");
            worker.close();
        })
        .await;
}

#[tokio::test]
async fn reports_task_failures_and_recovers_after_losing_the_worker() {
    LocalSet::new()
        .run_until(async {
            let worker = worker();
            let (_, initial) = worker.run(Job::Work(1), None).await.unwrap();
            let fail = worker.run(Job::Fail, None).await.unwrap_err();
            assert_eq!(fail.to_string(), "synthetic task failure");
            assert_eq!(worker.run(Job::Work(2), None).await.unwrap(), (2, initial));
            let exit = worker.run(Job::Exit, None);
            let next = worker.run(Job::Work(3), None);
            assert_eq!(
                exit.await.unwrap_err().to_string(),
                "Token fitting worker exited"
            );
            let (value, replacement) = next.await.unwrap();
            assert_eq!(value, 3);
            assert_ne!(replacement, initial);
            worker.close();
        })
        .await;
}

#[tokio::test]
async fn rejects_running_queued_and_later_tasks_once_closed() {
    LocalSet::new()
        .run_until(async {
            let worker = worker();
            let (blocked, entered, release) = blocked_job();
            let running = worker.run(blocked, None);
            entered.await.unwrap();
            let waiting = worker.run(Job::Work(1), None);
            worker.close();
            assert_eq!(
                running.await.unwrap_err().to_string(),
                "Token fitting is closed"
            );
            assert_eq!(
                waiting.await.unwrap_err().to_string(),
                "Token fitting is closed"
            );
            assert_eq!(
                worker
                    .run(Job::Work(2), None)
                    .await
                    .unwrap_err()
                    .to_string(),
                "Token fitting is closed"
            );
            release.send(()).unwrap();
        })
        .await;
}

#[tokio::test]
async fn worker_assessment_prompt_and_projection_match_bun_bytes() {
    LocalSet::new()
        .run_until(async {
            let output = Command::new("bun")
                .arg(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/tests/oracles/token-fitting-worker.ts"
                ))
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let probes: Vec<Value> = json::from_slice(&output.stdout).unwrap();
            let worker = TokenFittingWorker::new();
            for probe in probes {
                let messages = Arc::new(parse_chat_messages(&probe["messages"]).unwrap());
                let destination = &probe["destination"];
                let assessment = worker
                    .assess_carryover(Arc::clone(&messages), None)
                    .await
                    .unwrap();
                assert_eq!(
                    serde_json::to_vec(&assessment).unwrap(),
                    serde_json::to_vec(&probe["assessment"]).unwrap()
                );
                let fitted = worker
                    .fit_compaction_prompt(
                        Arc::clone(&messages),
                        CompactionDestination {
                            agent_id: destination["agentId"].as_str().unwrap().into(),
                            model: destination["model"].as_str().unwrap().into(),
                            prompt: destination["prompt"].as_str().map(str::to_owned),
                        },
                        probe["window"].as_f64().unwrap(),
                        probe["maximumEntryBudget"].as_f64(),
                        None,
                    )
                    .await
                    .unwrap();
                assert_eq!(
                    serde_json::to_vec(&fitted).unwrap(),
                    serde_json::to_vec(&probe["fitted"]).unwrap()
                );
                let projection = worker
                    .project_compacted_carryover(
                        messages,
                        probe["summary"].as_str().unwrap().into(),
                        None,
                    )
                    .await
                    .unwrap();
                assert_eq!(
                    serde_json::to_vec(&projection).unwrap(),
                    serde_json::to_vec(&probe["projection"]).unwrap()
                );
            }
            worker.close();
        })
        .await;
}
