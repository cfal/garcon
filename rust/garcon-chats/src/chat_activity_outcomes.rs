//! Process-only run results, fenced against view and run replacement.

use std::{cell::RefCell, collections::HashMap, rc::Rc};

use garcon_contract::{chat_activity::ChatRunOutcome, chat_id::ChatId};

struct ActivityOutcome {
    view_id: String,
    outcome: Option<ChatRunOutcome>,
    live: bool,
}

#[derive(PartialEq, Eq)]
enum RunStatus {
    Started,
    Terminal,
    Retired,
}

struct ActivityRun {
    view_id: Option<String>,
    run_id: String,
    status: RunStatus,
}

pub struct ActivityOutcomeAttempt {
    chat_id: ChatId,
    state: Rc<ActivityOutcome>,
    run_id: Option<String>,
}

impl ActivityOutcomeAttempt {
    pub(crate) fn view_id(&self) -> &str {
        &self.state.view_id
    }
}

type CurrentView = dyn Fn(&ChatId) -> Option<String>;

pub struct ChatActivityOutcomes {
    current_view: Box<CurrentView>,
    by_chat: RefCell<HashMap<ChatId, Rc<ActivityOutcome>>>,
    runs: RefCell<HashMap<ChatId, ActivityRun>>,
}

impl ChatActivityOutcomes {
    pub fn new(current_view: impl Fn(&ChatId) -> Option<String> + 'static) -> Self {
        Self {
            current_view: Box::new(current_view),
            by_chat: RefCell::new(HashMap::new()),
            runs: RefCell::new(HashMap::new()),
        }
    }

    pub fn get(&self, chat_id: &ChatId) -> Option<ChatRunOutcome> {
        self.by_chat
            .borrow()
            .get(chat_id)
            .and_then(|state| state.outcome)
    }

    pub fn clear(&self, chat_id: &ChatId, run_id: Option<&str>) {
        if let Some(view_id) = self.view(chat_id) {
            self.set(chat_id, view_id, None, true);
        } else {
            self.by_chat.borrow_mut().remove(chat_id);
        }
        if let Some(run_id) = run_id.filter(|run_id| !run_id.is_empty()) {
            self.begin(chat_id, run_id);
        }
    }

    pub fn begin(&self, chat_id: &ChatId, run_id: &str) {
        let view_id = self.view(chat_id);
        {
            let mut runs = self.runs.borrow_mut();
            if runs.get(chat_id).is_none_or(|run| run.run_id != run_id) {
                runs.insert(
                    chat_id.clone(),
                    ActivityRun {
                        view_id: view_id.clone(),
                        run_id: run_id.into(),
                        status: RunStatus::Started,
                    },
                );
            }
        }
        let Some(view_id) = view_id else {
            self.by_chat.borrow_mut().remove(chat_id);
            return;
        };
        let outcome = self
            .by_chat
            .borrow()
            .get(chat_id)
            .filter(|state| state.view_id == view_id)
            .and_then(|state| state.outcome);
        self.set(chat_id, view_id, outcome, true);
    }

    pub fn capture_failure(
        &self,
        chat_id: &ChatId,
        run_id: Option<&str>,
    ) -> Option<ActivityOutcomeAttempt> {
        self.capture(chat_id, run_id)
            .filter(|attempt| self.can_fail(attempt))
    }

    pub fn capture_terminal(
        &self,
        chat_id: &ChatId,
        view_id: &str,
        run_id: &str,
    ) -> Option<ActivityOutcomeAttempt> {
        let mut attempt = self.capture(chat_id, Some(run_id))?;
        if attempt.state.view_id != view_id {
            return None;
        }
        let mut runs = self.runs.borrow_mut();
        if runs.get(chat_id).is_some_and(|run| {
            run.run_id != run_id
                || run.status == RunStatus::Retired
                || run.view_id.as_deref().is_some_and(|bound| bound != view_id)
        }) {
            return None;
        }
        // Terminal authority is recorded before display publication can be delayed.
        runs.insert(
            chat_id.clone(),
            ActivityRun {
                view_id: Some(view_id.into()),
                run_id: run_id.into(),
                status: RunStatus::Terminal,
            },
        );
        attempt.state = self.set(chat_id, view_id.into(), attempt.state.outcome, true);
        Some(attempt)
    }

    pub fn capture_repair(&self, chat_id: &ChatId) -> Option<ActivityOutcomeAttempt> {
        if self
            .by_chat
            .borrow()
            .get(chat_id)
            .is_some_and(|state| state.live)
        {
            return None;
        }
        self.capture(chat_id, None)
    }

    pub fn invalidate_view(&self, chat_id: &ChatId) {
        self.by_chat.borrow_mut().remove(chat_id);
        if let Some(run) = self.runs.borrow_mut().get_mut(chat_id) {
            run.status = RunStatus::Retired;
        }
    }

    pub fn delete(&self, chat_id: &ChatId) {
        self.by_chat.borrow_mut().remove(chat_id);
        self.runs.borrow_mut().remove(chat_id);
    }

    pub fn fail(&self, attempt: Option<&ActivityOutcomeAttempt>) -> bool {
        let Some(attempt) =
            attempt.filter(|attempt| self.is_current(attempt) && self.can_fail(attempt))
        else {
            return false;
        };
        self.set_outcome(attempt, Some(ChatRunOutcome::Failed), true);
        true
    }

    pub fn restore(
        &self,
        attempt: &ActivityOutcomeAttempt,
        outcome: Option<ChatRunOutcome>,
    ) -> bool {
        if attempt.state.live || !self.is_current(attempt) {
            return false;
        }
        self.set_outcome(attempt, outcome, false);
        true
    }

    pub fn commit(
        &self,
        attempt: Option<&ActivityOutcomeAttempt>,
        outcome: ChatRunOutcome,
    ) -> bool {
        let Some(attempt) = attempt.filter(|attempt| self.is_current(attempt)) else {
            return false;
        };
        self.set_outcome(attempt, Some(outcome), true);
        true
    }

    fn view(&self, chat_id: &ChatId) -> Option<String> {
        (self.current_view)(chat_id).filter(|view_id| !view_id.is_empty())
    }

    fn capture(&self, chat_id: &ChatId, run_id: Option<&str>) -> Option<ActivityOutcomeAttempt> {
        let view_id = self.view(chat_id)?;
        let current = self.by_chat.borrow().get(chat_id).cloned();
        let state = current
            .filter(|state| state.view_id == view_id)
            .unwrap_or_else(|| self.set(chat_id, view_id, None, false));
        Some(ActivityOutcomeAttempt {
            chat_id: chat_id.clone(),
            state,
            run_id: run_id.map(str::to_owned),
        })
    }

    fn can_fail(&self, attempt: &ActivityOutcomeAttempt) -> bool {
        let Some(run_id) = attempt
            .run_id
            .as_deref()
            .filter(|run_id| !run_id.is_empty())
        else {
            return true;
        };
        self.runs.borrow().get(&attempt.chat_id).is_none_or(|run| {
            run.run_id == run_id
                && run.status == RunStatus::Started
                && run
                    .view_id
                    .as_deref()
                    .is_none_or(|view| view == attempt.state.view_id)
        })
    }

    fn is_current(&self, attempt: &ActivityOutcomeAttempt) -> bool {
        let same = self
            .by_chat
            .borrow()
            .get(&attempt.chat_id)
            .is_some_and(|state| Rc::ptr_eq(state, &attempt.state));
        same && self.view(&attempt.chat_id).as_deref() == Some(&attempt.state.view_id)
    }

    fn set_outcome(
        &self,
        attempt: &ActivityOutcomeAttempt,
        outcome: Option<ChatRunOutcome>,
        live: bool,
    ) {
        self.set(
            &attempt.chat_id,
            attempt.state.view_id.clone(),
            outcome,
            live,
        );
    }

    fn set(
        &self,
        chat_id: &ChatId,
        view_id: String,
        outcome: Option<ChatRunOutcome>,
        live: bool,
    ) -> Rc<ActivityOutcome> {
        let state = Rc::new(ActivityOutcome {
            view_id,
            outcome,
            live,
        });
        self.by_chat
            .borrow_mut()
            .insert(chat_id.clone(), state.clone());
        state
    }
}
