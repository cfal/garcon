use std::{cell::RefCell, rc::Rc};

use indexmap::IndexMap;

use crate::app_server::{
    client::CodexAppServerClient, operation_routes::CodexOperation,
    runtime_session_state::CodexTurnRoutes, turn_item_ledger::CodexTurnItemLedger,
};

pub struct CodexSessionSource {
    pub chat_id: String,
    pub thread_id: String,
    pub client: CodexAppServerClient,
    pub routes: RefCell<CodexTurnRoutes>,
    pub(super) items: RefCell<CodexTurnItemLedger>,
    pub(super) live_raw_results: RefCell<IndexMap<String, String>>,
}

impl CodexSessionSource {
    pub fn new(
        thread_id: String,
        client: CodexAppServerClient,
        operation: Rc<CodexOperation>,
    ) -> Self {
        Self {
            chat_id: operation.chat_id.clone(),
            thread_id,
            client,
            routes: RefCell::new(CodexTurnRoutes::new(operation)),
            items: RefCell::default(),
            live_raw_results: RefCell::default(),
        }
    }
}

#[derive(Default)]
pub struct CodexSourceRegistry {
    active: IndexMap<String, Rc<CodexSessionSource>>,
    sources: IndexMap<usize, Rc<CodexSessionSource>>,
    latest_by_chat: IndexMap<String, Rc<CodexSessionSource>>,
}

impl CodexSourceRegistry {
    pub fn active(&self, thread_id: &str) -> Option<Rc<CodexSessionSource>> {
        self.active.get(thread_id).cloned()
    }

    pub fn latest_for_chat(&self, chat_id: &str) -> Option<Rc<CodexSessionSource>> {
        self.latest_by_chat.get(chat_id).cloned()
    }

    pub fn session_for_client_thread(
        &self,
        client: &CodexAppServerClient,
        thread_id: &str,
    ) -> Option<Rc<CodexSessionSource>> {
        self.active(thread_id)
            .filter(|source| source.client.identity() == client.identity())
    }

    pub fn source_for_client_thread(
        &self,
        client: &CodexAppServerClient,
        thread_id: &str,
    ) -> Option<Rc<CodexSessionSource>> {
        self.sources
            .get(&client.identity())
            .filter(|source| source.thread_id == thread_id)
            .cloned()
    }

    pub fn source_for_client_turn(
        &self,
        client: &CodexAppServerClient,
        thread_id: &str,
        turn_id: &str,
    ) -> Option<Rc<CodexSessionSource>> {
        self.source_for_client_thread(client, thread_id)
            .filter(|source| source.routes.borrow().operation_for_turn(turn_id).is_some())
    }

    /// Returns the previous sources for the caller to shut down.
    pub fn activate(&mut self, source: Rc<CodexSessionSource>) -> Vec<Rc<CodexSessionSource>> {
        let latest = self.latest_for_chat(&source.chat_id);
        let active = self.active(&source.thread_id);
        let mut retired = Vec::new();
        for previous in [latest, active].into_iter().flatten() {
            if !Rc::ptr_eq(&previous, &source)
                && let Some(previous) = self.retire(&previous.client)
            {
                retired.push(previous);
            }
        }
        self.active.insert(source.thread_id.clone(), source.clone());
        self.latest_by_chat
            .insert(source.chat_id.clone(), source.clone());
        self.sources.insert(source.client.identity(), source);
        retired
    }

    pub fn finish(&mut self, source: &CodexSessionSource) {
        if self
            .active
            .get(&source.thread_id)
            .is_some_and(|current| std::ptr::eq(current.as_ref(), source))
        {
            self.active.shift_remove(&source.thread_id);
        }
    }

    pub fn retire(&mut self, client: &CodexAppServerClient) -> Option<Rc<CodexSessionSource>> {
        let source = self.sources.shift_remove(&client.identity())?;
        self.finish(&source);
        if self
            .latest_by_chat
            .get(&source.chat_id)
            .is_some_and(|current| Rc::ptr_eq(current, &source))
        {
            self.latest_by_chat.shift_remove(&source.chat_id);
        }
        source.routes.borrow_mut().retire();
        Some(source)
    }

    pub fn for_release(
        &self,
        chat_id: &str,
        thread_id: Option<&str>,
    ) -> Vec<Rc<CodexSessionSource>> {
        self.sources
            .values()
            .filter(|source| {
                source.chat_id == chat_id && Some(source.thread_id.as_str()) == thread_id
            })
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use crate::app_server::{
        client::CodexAppServerClientOptions, operation_routes::codex_operation,
    };

    use super::*;

    fn source(chat: &str, thread: &str, run: &str) -> Rc<CodexSessionSource> {
        let operation = codex_operation(chat, run, Rc::new(|_| {}));
        let client = CodexAppServerClient::new(CodexAppServerClientOptions::new(Rc::new(|_| {
            unreachable!("routing does not start a process")
        })));
        let source = Rc::new(CodexSessionSource::new(
            thread.into(),
            client,
            operation.clone(),
        ));
        assert!(CodexTurnRoutes::adopt_turn(
            &source.routes,
            "turn-1",
            operation
        ));
        source
    }

    #[test]
    fn scopes_turn_identity_to_the_client_and_thread_even_after_finish() {
        let a = source("a", "thread-a", "run-a");
        let b = source("b", "thread-b", "run-b");
        let mut registry = CodexSourceRegistry::default();
        assert!(registry.activate(a.clone()).is_empty());
        assert!(registry.activate(b.clone()).is_empty());
        assert!(
            registry
                .source_for_client_turn(&a.client, "thread-b", "turn-1")
                .is_none()
        );
        assert!(
            registry
                .source_for_client_turn(&b.client, "thread-b", "foreign")
                .is_none()
        );
        registry.finish(&a);
        assert!(
            registry
                .session_for_client_thread(&a.client, "thread-a")
                .is_none()
        );
        assert!(Rc::ptr_eq(
            &registry
                .source_for_client_turn(&a.client, "thread-a", "turn-1")
                .unwrap(),
            &a
        ));
        assert!(Rc::ptr_eq(
            &registry.for_release("a", Some("thread-a"))[0],
            &a
        ));
        assert!(registry.for_release("b", Some("thread-a")).is_empty());
        registry.retire(&a.client);
        assert!(
            registry
                .source_for_client_turn(&a.client, "thread-a", "turn-1")
                .is_none()
        );
        assert!(a.routes.borrow().operation_for_turn("turn-1").is_none());
        assert!(registry.active("thread-b").is_some());
    }

    #[test]
    fn replacing_a_source_cannot_remove_a_sibling_or_let_an_old_exit_remove_the_replacement() {
        let old = source("a", "thread-a", "old-run");
        let new = source("a", "thread-a", "new-run");
        let sibling = source("b", "thread-b", "sibling-run");
        let mut registry = CodexSourceRegistry::default();
        registry.activate(old.clone());
        registry.activate(sibling.clone());
        let retired = registry.activate(new.clone());
        assert_eq!(retired.len(), 1);
        assert!(Rc::ptr_eq(&retired[0], &old));
        assert!(registry.retire(&old.client).is_none());
        assert!(Rc::ptr_eq(&registry.latest_for_chat("a").unwrap(), &new));
        assert!(Rc::ptr_eq(&registry.active("thread-b").unwrap(), &sibling));
    }
}
