use std::cell::RefCell;
use std::error::Error;
use std::rc::Rc;

use garcon_base::json_file_store::{JsonFileStore, JsonWriteOptions, WriteFileError};
use garcon_js::{is_safe_integer, json};
use serde::Serialize;
use serde_json::Value;

type BoxError = Box<dyn Error>;
type Result<T> = std::result::Result<T, BoxError>;

pub mod access;
pub mod assignments;
pub mod reference_writes;
pub mod service;
pub mod store;

#[cfg(test)]
mod tests;

type Listener = Rc<dyn Fn() -> Result<()>>;

#[derive(Default)]
struct Listeners(Rc<RefCell<Vec<Listener>>>);

impl Listeners {
    fn subscribe(&self, listener: Listener) -> impl FnOnce() + use<> {
        let mut listeners = self.0.borrow_mut();
        if !listeners.iter().any(|entry| Rc::ptr_eq(entry, &listener)) {
            listeners.push(listener.clone());
        }
        let all = Rc::downgrade(&self.0);
        move || {
            if let Some(all) = all.upgrade() {
                all.borrow_mut()
                    .retain(|entry| !Rc::ptr_eq(entry, &listener));
            }
        }
    }

    fn publish(&self) -> Result<()> {
        let listeners = self.0.borrow().clone();
        for listener in listeners {
            listener()?;
        }
        Ok(())
    }
}

fn revision(value: &Value) -> Option<i64> {
    json::as_number(value)
        .filter(|number| *number >= 0.0 && is_safe_integer(*number))
        .map(|number| number as i64)
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::String(value) => !value.is_empty(),
        Value::Number(_) => json::as_number(value).is_some_and(|value| value != 0.0),
        Value::Array(_) | Value::Object(_) => true,
    }
}

#[derive(Debug, thiserror::Error)]
#[error(transparent)]
struct UncertainWrite(BoxError);

pub fn renamed_write(error: &(dyn Error + 'static)) -> bool {
    error.is::<UncertainWrite>()
        || matches!(error.downcast_ref::<WriteFileError>(), Some(WriteFileError::Atomic(error)) if error.renamed)
}

#[async_trait::async_trait(?Send)]
trait SnapshotWriter<T> {
    async fn write(&self, path: &str, value: &T) -> Result<()>;
}

#[async_trait::async_trait(?Send)]
impl<T: Serialize> SnapshotWriter<T> for JsonFileStore {
    async fn write(&self, path: &str, value: &T) -> Result<()> {
        self.write_json_file_atomic(
            path,
            value,
            JsonWriteOptions {
                mode: Some(0o600),
                ..Default::default()
            },
        )
        .await
        .map_err(Into::into)
    }
}
