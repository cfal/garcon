//! Reports failures from explicitly detached work without stopping the server.
//!
//! Rust does not emit Bun's process-wide unhandledRejection event. Detached
//! work supplies its result to this observer instead.

use std::cell::Cell;
use std::rc::Rc;

use crate::{
    errors::{ErrorInput, error_message},
    log::Logger,
};

pub struct UnhandledRejectionPolicy {
    active: Cell<bool>,
    logger: Rc<dyn Logger>,
}

pub fn install_unhandled_rejection_policy(logger: Rc<dyn Logger>) -> UnhandledRejectionPolicy {
    UnhandledRejectionPolicy {
        active: Cell::new(true),
        logger,
    }
}

impl UnhandledRejectionPolicy {
    pub fn report(&self, error: ErrorInput<'_>) {
        if self.active.get() {
            let message = error_message(error, None);
            self.logger
                .error(&format!("unhandled rejection (non-fatal): {message}"));
        }
    }

    pub fn uninstall(&self) {
        self.active.set(false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct Messages(RefCell<Vec<String>>);

    impl Logger for Messages {
        fn debug(&self, _: &str) {}
        fn info(&self, _: &str) {}
        fn warn(&self, _: &str) {}
        fn error(&self, message: &str) {
            self.0.borrow_mut().push(message.to_owned());
        }
    }

    #[test]
    fn logs_without_throwing_until_uninstalled() {
        let logger = Rc::new(Messages::default());
        let policy = install_unhandled_rejection_policy(logger.clone());
        let error = std::io::Error::other("synthetic failure");
        policy.report(ErrorInput::Error(&error));
        policy.uninstall();
        policy.report(ErrorInput::Error(&error));
        assert_eq!(
            *logger.0.borrow(),
            ["unhandled rejection (non-fatal): synthetic failure"]
        );
    }
}
