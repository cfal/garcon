use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

use futures::{
    FutureExt,
    future::{LocalBoxFuture, Shared},
};
use garcon_interface::host::AgentLogger;
use garcon_js::json::Opaque;
use indexmap::IndexMap;
use serde_json::json;

use crate::app_server::client::CodexAppServerClient;

type Acknowledgement = Shared<LocalBoxFuture<'static, bool>>;

#[derive(Default)]
pub struct CodexInterrupt {
    next_generation: Cell<u64>,
    attempt: RefCell<Option<(u64, Acknowledgement)>>,
}

impl CodexInterrupt {
    pub fn current(&self) -> Option<impl Future<Output = bool> + use<>> {
        self.attempt
            .borrow()
            .as_ref()
            .map(|(_, acknowledgement)| acknowledgement.clone())
    }

    pub fn clear(&self) {
        self.attempt.borrow_mut().take();
    }

    pub fn begin<F: FnOnce() + 'static>(
        self: &Rc<Self>,
        client: CodexAppServerClient,
        thread_id: String,
        turn_id: String,
        logger: Rc<dyn AgentLogger>,
        on_rejection: F,
    ) -> impl Future<Output = bool> + use<F> {
        if let Some((_, acknowledgement)) = self.attempt.borrow().as_ref() {
            return acknowledgement.clone();
        }
        let generation = self.next_generation.get();
        self.next_generation.set(generation + 1);
        let owner = Rc::downgrade(self);
        let acknowledgement = async move {
            let result = client
                .request(
                    "turn/interrupt",
                    Some(&json!({
                        "threadId": thread_id, "turnId": turn_id,
                    })),
                    None,
                )
                .await;
            match result {
                Ok(_) => true,
                Err(error) => {
                    if let Some(owner) = owner.upgrade() {
                        let is_current = owner
                            .attempt
                            .borrow()
                            .as_ref()
                            .is_some_and(|(current, _)| *current == generation);
                        if is_current {
                            owner.clear();
                            on_rejection();
                        }
                    }
                    logger.warn(
                        "Codex turn interruption failed",
                        Some(&IndexMap::from([
                            ("turnId".into(), Opaque::from_value(json!(turn_id))),
                            ("error".into(), Opaque::from_value(json!(error.to_string()))),
                        ])),
                    );
                    false
                }
            }
        }
        .boxed_local()
        .shared();
        *self.attempt.borrow_mut() = Some((generation, acknowledgement.clone()));
        tokio::task::spawn_local(acknowledgement.clone());
        acknowledgement
    }
}
