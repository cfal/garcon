//! Advisory native transcript drift detection. It never mutates the ledger.

use std::{cell::RefCell, collections::HashMap, rc::Rc, time::Duration};

use garcon_base::log::{Logger, ScopedLogger, create_logger};
use garcon_contract::{
    executors::effective_executor_id,
    ws_events::{ChatOperationalNoticeDetail, ChatOperationalNoticeType},
};
use garcon_interface::{
    native_history::{AgentNativeActivityProbe, AgentNativeActivityResult},
    resources::ExecutorResult,
    transcript::AgentNativeSessionRef,
};
use garcon_js::date_parse::date_parse;
use garcon_ledger::contracts::TranscriptViewId;
use serde_json::Value;
use tokio::time::{Instant, sleep_until};
use tokio_util::sync::CancellationToken;

use crate::{native_activity_page_reader::NativeActivityCheck, store::ChatRegistry};

pub const NATIVE_TRANSCRIPT_DRIFT_NOTICE: &str =
    "The transcript may have changed outside Garcon. Consider reloading from native history.";
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub struct NativeActivityBinding {
    pub view_id: TranscriptViewId,
    pub session_ordinal: u64,
    pub native_session: AgentNativeSessionRef,
    pub provider_ordinal: u64,
    pub provider_at: String,
}

pub type NativeActivityBindingReader =
    dyn Fn(&str) -> ExecutorResult<Option<NativeActivityBinding>>;
pub type NativeActivityProbeLookup =
    dyn Fn(&str, Option<&str>) -> Option<Rc<dyn AgentNativeActivityProbe>>;
pub type OperationalNotice = dyn Fn(
    &str,
    ChatOperationalNoticeType,
    &str,
    ChatOperationalNoticeDetail,
) -> ExecutorResult<()>;

pub struct NativeTranscriptActivityOptions {
    pub registry: Rc<ChatRegistry>,
    pub read_binding: Rc<NativeActivityBindingReader>,
    pub probe_for: Rc<NativeActivityProbeLookup>,
    pub owns_execution: Rc<dyn Fn(&str) -> bool>,
    pub notify_operational_notice: Rc<OperationalNotice>,
}

struct Eligibility {
    executor_id: String,
    agent_id: String,
    binding: NativeActivityBinding,
}

impl Eligibility {
    fn matches(&self, other: &Self) -> bool {
        let left = &self.binding;
        let right = &other.binding;
        self.executor_id == other.executor_id
            && self.agent_id == other.agent_id
            && left.view_id == right.view_id
            && left.session_ordinal == right.session_ordinal
            && left.provider_ordinal == right.provider_ordinal
            && left.provider_at == right.provider_at
            && left.native_session.owner_id == right.native_session.owner_id
            && left.native_session.schema_version == right.native_session.schema_version
            && equal_json(
                left.native_session.value.as_value(),
                right.native_session.value.as_value(),
            )
    }
}

struct Attempt {
    eligibility: Eligibility,
    cancellation: CancellationToken,
}

struct Activity {
    options: NativeTranscriptActivityOptions,
    pending: RefCell<HashMap<String, Rc<Attempt>>>,
    logger: ScopedLogger,
}

pub struct NativeTranscriptActivity(Rc<Activity>);

impl NativeTranscriptActivity {
    pub fn new(options: NativeTranscriptActivityOptions) -> Self {
        Self(Rc::new(Activity {
            options,
            pending: RefCell::default(),
            logger: create_logger("ledger:native-activity"),
        }))
    }
}

impl NativeActivityCheck for NativeTranscriptActivity {
    fn request_activation_check(&self, chat_id: &str) {
        let eligible = if (self.0.options.owns_execution)(chat_id) {
            Ok(None)
        } else {
            self.0.eligibility(chat_id)
        };
        let mut pending = self.0.pending.borrow_mut();
        let (eligibility, probe) = match eligible {
            Ok(Some(eligible)) => eligible,
            result => {
                if let Some(current) = pending.remove(chat_id) {
                    current.cancellation.cancel();
                }
                if result.is_err() {
                    self.0.warn(
                        "Native transcript activity eligibility failed",
                        chat_id,
                        "NATIVE_ACTIVITY_ELIGIBILITY_FAILED",
                        None,
                    );
                }
                return;
            }
        };
        if let Some(current) = pending.get(chat_id) {
            if current.eligibility.matches(&eligibility) {
                return;
            }
            current.cancellation.cancel();
        }
        let attempt = Rc::new(Attempt {
            eligibility,
            cancellation: CancellationToken::new(),
        });
        pending.insert(chat_id.into(), attempt.clone());
        drop(pending);
        let activity = self.0.clone();
        let chat_id = chat_id.to_owned();
        let deadline = Instant::now() + PROBE_TIMEOUT;
        tokio::task::spawn_local(async move {
            let result = activity.run(&chat_id, &attempt, probe, deadline).await;
            if activity
                .pending
                .borrow()
                .get(&chat_id)
                .is_some_and(|owner| Rc::ptr_eq(owner, &attempt))
            {
                activity.pending.borrow_mut().remove(&chat_id);
            }
            if result.is_err() {
                activity.warn(
                    "Native transcript activity check failed",
                    &chat_id,
                    "NATIVE_ACTIVITY_CHECK_FAILED",
                    None,
                );
            }
        });
    }
}

impl Activity {
    fn eligibility(
        &self,
        chat_id: &str,
    ) -> ExecutorResult<Option<(Eligibility, Rc<dyn AgentNativeActivityProbe>)>> {
        let Some(entry) = self.options.registry.get_chat(chat_id) else {
            return Ok(None);
        };
        let Some(probe) = (self.options.probe_for)(&entry.agent_id, entry.executor_id.as_deref())
        else {
            return Ok(None);
        };
        let Some(binding) = (self.options.read_binding)(chat_id)? else {
            return Ok(None);
        };
        Ok(Some((
            Eligibility {
                executor_id: effective_executor_id(entry.executor_id.as_deref()),
                agent_id: entry.agent_id,
                binding,
            },
            probe,
        )))
    }

    async fn run(
        &self,
        chat_id: &str,
        attempt: &Attempt,
        probe: Rc<dyn AgentNativeActivityProbe>,
        deadline: Instant,
    ) -> ExecutorResult<()> {
        let key = &attempt.eligibility;
        let cancel = &attempt.cancellation;
        let outcome = tokio::select! {
            biased;
            () = cancel.cancelled() => return Ok(()),
            result = probe.last_activity(key.binding.native_session.clone(), cancel.clone()) => result,
            () = sleep_until(deadline) => {
                self.warn("Native transcript activity check timed out", chat_id, "NATIVE_ACTIVITY_CHECK_TIMEOUT", None);
                cancel.cancel();
                return Ok(());
            }
        };
        if cancel.is_cancelled() {
            return Ok(());
        }
        let native_at = match outcome {
            Ok(AgentNativeActivityResult::Ready { value }) => value.last_entry_at,
            Ok(AgentNativeActivityResult::Unavailable) => None,
            Err(_) => {
                self.warn(
                    "Native transcript activity probe failed",
                    chat_id,
                    "NATIVE_ACTIVITY_PROBE_FAILED",
                    Some(&key.agent_id),
                );
                None
            }
        };
        let Some(native_at) = native_at else {
            return Ok(());
        };
        let Some(observed_at) = date_parse(&native_at) else {
            self.warn(
                "Native transcript activity probe returned an invalid timestamp",
                chat_id,
                "NATIVE_ACTIVITY_INVALID_TIMESTAMP",
                Some(&key.agent_id),
            );
            return Ok(());
        };
        if (self.options.owns_execution)(chat_id) {
            return Ok(());
        }
        let Some((current, _)) = self.eligibility(chat_id)? else {
            return Ok(());
        };
        if key.matches(&current)
            && date_parse(&current.binding.provider_at)
                .is_some_and(|provider_at| observed_at > provider_at)
        {
            (self.options.notify_operational_notice)(
                chat_id,
                ChatOperationalNoticeType::Warning,
                NATIVE_TRANSCRIPT_DRIFT_NOTICE,
                ChatOperationalNoticeDetail::NativeTranscriptDrift,
            )?;
        }
        Ok(())
    }

    fn warn(&self, message: &str, chat_id: &str, code: &str, agent_id: Option<&str>) {
        let agent_id = agent_id
            .map(|id| format!(", agentId: {id}"))
            .unwrap_or_default();
        self.logger.warn(&format!(
            "{message} {{ chatId: {chat_id}, reason: activation, code: {code}{agent_id} }}"
        ));
    }
}

// Native references compare by JSON value, but JavaScript's deep equality
// also distinguishes the sign of zero.
fn equal_json(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => {
            left.as_f64().map(f64::to_bits) == right.as_f64().map(f64::to_bits)
        }
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| equal_json(left, right))
        }
        (Value::Object(left), Value::Object(right)) => {
            left.len() == right.len()
                && left.iter().all(|(key, value)| {
                    right.get(key).is_some_and(|other| equal_json(value, other))
                })
        }
        _ => left == right,
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use async_trait::async_trait;
    use garcon_interface::native_history::AgentNativeActivity;
    use garcon_ledger::contracts::transcript_view_id;
    use serde_json::json;
    use tokio::{
        sync::{mpsc, oneshot},
        task::LocalSet,
    };

    use super::*;

    const CHAT: &str = "1000000000000001";
    const AT: &str = "2026-11-28T10:00:00.000Z";
    const LATER: &str = "2026-11-28T10:00:00.001Z";

    struct ProbeRequest {
        cancellation: CancellationToken,
        answer: oneshot::Sender<AgentNativeActivityResult>,
    }

    impl ProbeRequest {
        fn finish(self, at: &str) {
            self.answer
                .send(AgentNativeActivityResult::Ready {
                    value: AgentNativeActivity {
                        last_entry_at: Some(at.into()),
                    },
                })
                .unwrap();
        }
    }

    struct Probe(mpsc::UnboundedSender<ProbeRequest>);

    #[async_trait(?Send)]
    impl AgentNativeActivityProbe for Probe {
        async fn last_activity(
            &self,
            native_session: AgentNativeSessionRef,
            cancellation: CancellationToken,
        ) -> ExecutorResult<AgentNativeActivityResult> {
            assert_eq!(native_session.owner_id, "shell");
            let (answer, result) = oneshot::channel();
            self.0
                .send(ProbeRequest {
                    cancellation,
                    answer,
                })
                .unwrap();
            Ok(result.await?)
        }
    }

    struct Fixture {
        _temporary: tempfile::TempDir,
        service: NativeTranscriptActivity,
        binding: Rc<RefCell<NativeActivityBinding>>,
        owns_execution: Rc<Cell<bool>>,
        probes: mpsc::UnboundedReceiver<ProbeRequest>,
        notices: Rc<RefCell<Vec<String>>>,
    }

    async fn fixture() -> Fixture {
        let directory = tempfile::tempdir().unwrap();
        let entry = json!({
            "agentId":"shell","agentOwnershipEpoch":"fixture-epoch","agentSettingsById":{},
            "projectPath":"/srv/seeded-project","carryOverSegments":[],"nativeSeedReceipt":null,
            "carryOverMigrationQuarantine":null,"parentChatId":null,"lineage":null,
        });
        std::fs::write(
            directory.path().join("chats.json"),
            json!({
                "version":6, "sessions":{(CHAT):entry},
            })
            .to_string(),
        )
        .unwrap();
        let registry = ChatRegistry::open(directory.path()).await.unwrap();
        let binding = Rc::new(RefCell::new(NativeActivityBinding {
            view_id: transcript_view_id("view").unwrap(),
            session_ordinal: 1,
            native_session: AgentNativeSessionRef {
                owner_id: "shell".into(),
                schema_version: 1,
                value: json!({"id":"fixture"}).into(),
            },
            provider_ordinal: 2,
            provider_at: AT.into(),
        }));
        let owns_execution = Rc::new(Cell::new(false));
        let notices = Rc::new(RefCell::new(Vec::new()));
        let (send, probes) = mpsc::unbounded_channel();
        let probe: Rc<dyn AgentNativeActivityProbe> = Rc::new(Probe(send));
        let service = NativeTranscriptActivity::new(NativeTranscriptActivityOptions {
            registry,
            read_binding: {
                let binding = binding.clone();
                Rc::new(move |_| Ok(Some(binding.borrow().clone())))
            },
            probe_for: Rc::new(move |agent, executor| {
                assert_eq!(agent, "shell");
                assert!(executor.is_none());
                Some(probe.clone())
            }),
            owns_execution: {
                let owned = owns_execution.clone();
                Rc::new(move |_| owned.get())
            },
            notify_operational_notice: {
                let notices = notices.clone();
                Rc::new(move |chat, notice_type, message, detail| {
                    assert_eq!(chat, CHAT);
                    assert_eq!(notice_type, ChatOperationalNoticeType::Warning);
                    assert_eq!(detail, ChatOperationalNoticeDetail::NativeTranscriptDrift);
                    notices.borrow_mut().push(message.into());
                    Ok(())
                })
            },
        });
        Fixture {
            _temporary: directory,
            service,
            binding,
            owns_execution,
            probes,
            notices,
        }
    }

    #[tokio::test]
    async fn coalesces_equal_checks_and_supersedes_when_only_the_watermark_ordinal_changes() {
        let mut fixture = fixture().await;
        let tasks = LocalSet::new();
        tasks
            .run_until(async {
                fixture.service.request_activation_check(CHAT);
                let first = fixture.probes.recv().await.unwrap();
                fixture.service.request_activation_check(CHAT);
                tokio::task::yield_now().await;
                assert!(fixture.probes.try_recv().is_err());
                fixture.binding.borrow_mut().provider_ordinal += 1;
                fixture.service.request_activation_check(CHAT);
                assert!(first.cancellation.is_cancelled());
                let _ = first.answer.send(AgentNativeActivityResult::Ready {
                    value: AgentNativeActivity {
                        last_entry_at: Some(LATER.into()),
                    },
                });
                let second = fixture.probes.recv().await.unwrap();
                assert!(!second.cancellation.is_cancelled());
                second.finish(LATER);
            })
            .await;
        tasks.await;
        assert_eq!(*fixture.notices.borrow(), [NATIVE_TRANSCRIPT_DRIFT_NOTICE]);
        assert!(fixture.service.0.pending.borrow().is_empty());
    }

    #[tokio::test]
    async fn rechecks_ownership_and_the_exact_binding_before_publishing() {
        let mut fixture = fixture().await;
        for test in 0..4 {
            let tasks = LocalSet::new();
            tasks
                .run_until(async {
                    fixture.service.request_activation_check(CHAT);
                    let probe = fixture.probes.recv().await.unwrap();
                    match test {
                        0 => fixture.owns_execution.set(true),
                        1 => fixture.binding.borrow_mut().session_ordinal += 1,
                        _ => {}
                    }
                    probe.finish(if test == 2 { AT } else { LATER });
                })
                .await;
            tasks.await;
            fixture.owns_execution.set(false);
            assert_eq!(fixture.notices.borrow().len(), usize::from(test == 3));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn aborts_a_parked_probe_at_the_five_second_deadline() {
        let mut fixture = fixture().await;
        let tasks = LocalSet::new();
        tasks
            .run_until(async {
                fixture.service.request_activation_check(CHAT);
                let probe = fixture.probes.recv().await.unwrap();
                tokio::time::advance(PROBE_TIMEOUT - Duration::from_millis(1)).await;
                assert!(!probe.cancellation.is_cancelled());
                tokio::time::advance(Duration::from_millis(1)).await;
                probe.cancellation.cancelled().await;
                assert!(probe.answer.is_closed());
            })
            .await;
        tasks.await;
        assert!(fixture.notices.borrow().is_empty());
        assert!(fixture.service.0.pending.borrow().is_empty());
    }

    #[test]
    fn native_session_values_ignore_object_key_order_but_distinguish_negative_zero() {
        let value = garcon_js::json::parse(r#"{"id":"fixture","args":[-0,2]}"#).unwrap();
        let reordered = garcon_js::json::parse(r#"{"args":[-0,2],"id":"fixture"}"#).unwrap();
        let changed = garcon_js::json::parse(r#"{"args":[0,2],"id":"fixture"}"#).unwrap();
        assert!(equal_json(&value, &reordered));
        assert!(!equal_json(&value, &changed));
    }
}
