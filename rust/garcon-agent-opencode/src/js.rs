//! JavaScript semantics the integration relies on that `garcon-js` does not
//! hold: truthiness, strict equality, the property reads the
//! original writes with optional chaining, an `AbortController`'s reason, and
//! one error object shared by several consumers.

use std::cell::{OnceCell, Ref, RefCell, RefMut};
use std::error::Error;
use std::fmt;
use std::hash::{Hash, Hasher};
use std::ops::Deref;
use std::rc::Rc;
use std::sync::LazyLock;
use std::time::Duration;

use garcon_base::errors::NamedError;
use garcon_js::json::Opaque;
use garcon_js::trim;
use indexmap::IndexMap;
use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

static NULL: LazyLock<Value> = LazyLock::new(|| Value::Null);

/// A `new Error(message)` of the original, or of the class `name` names.
pub fn error(name: &str, message: impl Into<String>) -> Box<dyn Error> {
    NamedError {
        name: name.to_owned(),
        message: message.into(),
        code: None,
    }
    .into()
}

/// A value the original reads a property of: a JSON value, an object, or
/// either of them where `None` is the `undefined` of optional chaining.
pub trait Property {
    fn property(&self, key: &str) -> Option<&Value>;
}

impl Property for Value {
    fn property(&self, key: &str) -> Option<&Value> {
        self.as_object().and_then(|object| object.get(key))
    }
}

impl Property for Map<String, Value> {
    fn property(&self, key: &str) -> Option<&Value> {
        self.get(key)
    }
}

impl<T: Property + ?Sized> Property for &'_ T {
    fn property(&self, key: &str) -> Option<&Value> {
        (**self).property(key)
    }
}

impl<T: Property> Property for Option<T> {
    fn property(&self, key: &str) -> Option<&Value> {
        self.as_ref().and_then(|object| object.property(key))
    }
}

/// The property `key` of `object`: `null` where the original reads `undefined`.
pub fn prop<'a>(object: &'a (impl Property + ?Sized), key: &str) -> &'a Value {
    object.property(key).unwrap_or(&NULL)
}

/// The property `key` of `object` when it is present: `None` where the
/// original reads `undefined`, for the places where it tells that from `null`.
pub fn own<'a>(object: &'a (impl Property + ?Sized), key: &str) -> Option<&'a Value> {
    object.property(key)
}

/// `String(value)` as a template literal writes it; `None` is `undefined`.
pub fn string_of(value: Option<&Value>) -> std::borrow::Cow<'_, str> {
    match value {
        Some(value) => garcon_base::errors::js_string(garcon_base::errors::ErrorInput::Json(value)),
        None => garcon_base::errors::js_string(garcon_base::errors::ErrorInput::Undefined),
    }
}

/// Whether a JavaScript condition treats `value` as true.
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::String(value) => !value.is_empty(),
        Value::Number(_) => {
            garcon_js::json::as_number(value).is_some_and(|value| value != 0.0 && !value.is_nan())
        }
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// The `===` of the original between two JSON values. Two distinct objects or
/// arrays are never the same value.
pub fn strictly_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => {
            // `NaN !== NaN`, as the double comparison answers.
            left.as_f64() == right.as_f64()
        }
        (Value::String(left), Value::String(right)) => left == right,
        (Value::Bool(left), Value::Bool(right)) => left == right,
        (Value::Null, Value::Null) => true,
        (Value::Array(left), Value::Array(right)) => std::ptr::eq(left, right),
        (Value::Object(left), Value::Object(right)) => std::ptr::eq(left, right),
        _ => false,
    }
}

/// `Set.prototype.has` over two JSON values. SameValueZero differs from `===`
/// only for `NaN`, which no JSON value holds.
pub fn same_value_zero(left: &Value, right: &Value) -> bool {
    strictly_equal(left, right)
}

/// One failure every consumer sees the same way, as the original passes one
/// `Error` object to each of them.
#[derive(Debug, Clone)]
pub struct SharedError(Rc<dyn Error>);

impl SharedError {
    pub fn new(error: impl Error + 'static) -> Self {
        Self(Rc::new(error))
    }
}

impl From<Box<dyn Error>> for SharedError {
    fn from(error: Box<dyn Error>) -> Self {
        match error.downcast::<Self>() {
            Ok(shared) => *shared,
            Err(error) => Self(Rc::from(error)),
        }
    }
}

impl Deref for SharedError {
    type Target = dyn Error;

    fn deref(&self) -> &Self::Target {
        &*self.0
    }
}

impl fmt::Display for SharedError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&*self.0, formatter)
    }
}

impl Error for SharedError {}

/// A `new Error(message)` of the original, or of the class `name` names, kept
/// for more than one consumer.
pub fn shared_error(name: &str, message: impl Into<String>) -> SharedError {
    SharedError::new(NamedError {
        name: name.to_owned(),
        message: message.into(),
        code: None,
    })
}

/// The original's `error instanceof Class` for an error this crate defines.
/// The answer is the same whether the error reaches the check directly or
/// through a `SharedError`, which hides the class it holds.
pub fn error_of<'a, T: Error + 'static>(error: &'a (dyn Error + 'static)) -> Option<&'a T> {
    match error.downcast_ref::<SharedError>() {
        Some(shared) => shared.downcast_ref::<T>(),
        None => error.downcast_ref::<T>(),
    }
}

/// An `AbortController` together with the `AbortSignal` its callers hold. The
/// token ends waits; the reason is what `throwIfAborted()` throws.
#[derive(Debug, Clone, Default)]
pub struct AbortSignal {
    token: CancellationToken,
    reason: Rc<OnceCell<SharedError>>,
}

impl AbortSignal {
    pub fn new() -> Self {
        Self::default()
    }

    /// A signal that follows `token` and whose abort has no recorded reason.
    pub fn from_token(token: CancellationToken) -> Self {
        Self {
            token,
            reason: Rc::default(),
        }
    }

    /// `controller.abort(reason)`: the first reason is the one kept.
    pub fn abort(&self, reason: SharedError) {
        let _ = self.reason.set(reason);
        self.token.cancel();
    }

    pub fn aborted(&self) -> bool {
        self.token.is_cancelled()
    }

    pub fn token(&self) -> &CancellationToken {
        &self.token
    }

    /// `signal.reason`: `None` while the signal is not aborted, and the
    /// default `AbortError` when it was aborted without a recorded reason.
    pub fn reason(&self) -> Option<SharedError> {
        self.aborted().then(|| self.abort_reason())
    }

    /// The reason of a signal that is known to be aborted.
    pub fn abort_reason(&self) -> SharedError {
        self.reason
            .get()
            .cloned()
            .unwrap_or_else(|| shared_error("AbortError", "The operation was aborted."))
    }

    /// `signal.throwIfAborted()`.
    pub fn throw_if_aborted(&self) -> Result<(), Box<dyn Error>> {
        match self.reason() {
            Some(reason) => Err(reason.into()),
            None => Ok(()),
        }
    }
}

/// `setTimeout(fn, ms)`: a fractional delay loses its fraction, and a delay
/// under one millisecond or past what the timer holds fires after one, as in
/// `garcon_base::event_loop_stalls`.
pub fn timer_delay(ms: f64) -> Duration {
    const MAX_DELAY_MS: f64 = i32::MAX as f64;
    let fallback = Duration::from_millis(1);
    if !(1.0..=MAX_DELAY_MS).contains(&ms) {
        return fallback;
    }
    Duration::try_from_secs_f64(ms.trunc() / 1000.0).unwrap_or(fallback)
}

/// A mutable object the original passes by reference: every holder sees the
/// same state, and two handles are equal only when they are the same object,
/// which is what `===`, `Map`, and `Set` compare there.
pub struct Shared<T>(Rc<RefCell<T>>);

impl<T> Clone for Shared<T> {
    fn clone(&self) -> Self {
        Self(Rc::clone(&self.0))
    }
}

impl<T> Shared<T> {
    pub fn new(value: T) -> Self {
        Self(Rc::new(RefCell::new(value)))
    }

    pub fn ptr_eq(left: &Self, right: &Self) -> bool {
        Rc::ptr_eq(&left.0, &right.0)
    }

    pub fn borrow(&self) -> Ref<'_, T> {
        self.0.borrow()
    }

    pub fn borrow_mut(&self) -> RefMut<'_, T> {
        self.0.borrow_mut()
    }
}

impl<T> PartialEq for Shared<T> {
    fn eq(&self, other: &Self) -> bool {
        Self::ptr_eq(self, other)
    }
}

impl<T> Eq for Shared<T> {}

impl<T> Hash for Shared<T> {
    fn hash<H: Hasher>(&self, state: &mut H) {
        (Rc::as_ptr(&self.0) as usize).hash(state);
    }
}

impl<T: fmt::Debug> fmt::Debug for Shared<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_tuple("Shared").field(&self.0).finish()
    }
}

/// The fields of a log line of the original: `{ key: value, ... }` in the
/// order it writes them.
pub fn log_fields<const N: usize>(entries: [(&str, Value); N]) -> IndexMap<String, Opaque> {
    entries
        .into_iter()
        .map(|(key, value)| (key.to_owned(), Opaque::from_value(value)))
        .collect()
}

/// `text.toLowerCase().includes(needle)`.
pub fn to_lowercase_includes(text: &str, needle: &str) -> bool {
    text.to_lowercase().contains(needle)
}

pub fn is_js_whitespace(character: char) -> bool {
    trim(character.encode_utf8(&mut [0; 4])).is_empty()
}

/// Removes the whitespace, underscores, and hyphens of a lower-cased tool name.
pub fn strip_name_separators(text: &str) -> String {
    let mut stripped = String::with_capacity(text.len());
    stripped.extend(text.to_lowercase().chars().filter(|character| {
        *character != '_' && *character != '-' && !is_js_whitespace(*character)
    }));
    stripped
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_the_javascript_whitespace_and_name_separators() {
        assert_eq!(strip_name_separators(" Web_\t-Fetch "), "webfetch");
        assert_eq!(strip_name_separators("a\u{feff}b\u{a0}c\u{2028}d"), "abcd");
        assert_eq!(strip_name_separators("a\u{85}b"), "a\u{85}b");
    }

    #[test]
    fn compares_values_strictly() {
        assert!(strictly_equal(
            &Value::from(404u64),
            &serde_json::json!(404.0)
        ));
        assert!(!strictly_equal(
            &serde_json::json!({"a": 1}),
            &serde_json::json!({"a": 1})
        ));
        assert!(same_value_zero(
            &serde_json::json!(0),
            &serde_json::json!(0.0)
        ));
        assert!(strictly_equal(&Value::Null, &Value::Null));
        assert!(!strictly_equal(&Value::Null, &serde_json::json!(0)));
    }
}
