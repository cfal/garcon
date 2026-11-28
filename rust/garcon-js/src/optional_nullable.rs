//! A property that may be absent, `null`, or a value, as `T | null` written
//! with `?` is in TypeScript. The original keeps the three apart: an absent
//! property is left out of the JSON it writes, a `null` is written as `null`.

use std::fmt;
use std::ops::Deref;

use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Visitor};

/// `T | null | undefined`.
///
/// On a struct field it is declared with
/// `#[serde(default, skip_serializing_if = "OptionalNullable::is_absent")]`,
/// so that an absent property is left out and the other two are written.
///
/// ```
/// use garcon_js::OptionalNullable;
/// use serde::Serialize;
///
/// #[derive(Serialize)]
/// struct Target<'a> {
///     #[serde(default, skip_serializing_if = "OptionalNullable::is_absent")]
///     executor_id: OptionalNullable<&'a str>,
/// }
///
/// let absent = serde_json::to_string(&Target { executor_id: OptionalNullable::ABSENT }).unwrap();
/// let null = serde_json::to_string(&Target { executor_id: OptionalNullable::NULL }).unwrap();
/// let value =
///     serde_json::to_string(&Target { executor_id: OptionalNullable::some("local") }).unwrap();
/// assert_eq!(absent, "{}");
/// assert_eq!(null, "{\"executor_id\":null}");
/// assert_eq!(value, "{\"executor_id\":\"local\"}");
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct OptionalNullable<T>(Option<Option<T>>);

impl<T> OptionalNullable<T> {
    /// The property is absent.
    pub const ABSENT: Self = Self(None);

    /// The property is `null`.
    pub const NULL: Self = Self(Some(None));

    pub const fn some(value: T) -> Self {
        Self(Some(Some(value)))
    }

    pub const fn is_absent(&self) -> bool {
        self.0.is_none()
    }

    pub const fn is_null(&self) -> bool {
        matches!(self.0, Some(None))
    }

    /// The value, or `None` when the property is absent or `null`: what the
    /// original reads where it collapses the two with `??` or `!= null`.
    pub const fn as_option(&self) -> Option<&T> {
        match &self.0 {
            Some(Some(value)) => Some(value),
            _ => None,
        }
    }
}

impl<T: Deref> OptionalNullable<T> {
    pub fn as_deref(&self) -> Option<&T::Target> {
        self.as_option().map(Deref::deref)
    }
}

impl<T> From<Option<T>> for OptionalNullable<T> {
    fn from(value: Option<T>) -> Self {
        Self(Some(value))
    }
}

impl<T> Serialize for OptionalNullable<T>
where
    T: Serialize,
{
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match &self.0 {
            None => serializer.serialize_none(),
            Some(None) => serializer.serialize_none(),
            Some(Some(value)) => value.serialize(serializer),
        }
    }
}

impl<'de, T> Deserialize<'de> for OptionalNullable<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_option(OptionalNullableVisitor {
            marker: std::marker::PhantomData,
        })
    }
}

struct OptionalNullableVisitor<T> {
    marker: std::marker::PhantomData<T>,
}

impl<'de, T> Visitor<'de> for OptionalNullableVisitor<T>
where
    T: Deserialize<'de>,
{
    type Value = OptionalNullable<T>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("null or a value")
    }

    fn visit_none<E: serde::de::Error>(self) -> Result<Self::Value, E> {
        Ok(OptionalNullable::NULL)
    }

    fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
        Ok(OptionalNullable::NULL)
    }

    fn visit_some<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        T::deserialize(deserializer).map(OptionalNullable::some)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keeps_absent_null_and_a_value_apart() {
        let absent: OptionalNullable<String> = OptionalNullable::ABSENT;
        let null: OptionalNullable<String> = OptionalNullable::NULL;
        let value = OptionalNullable::some("local".to_owned());
        assert!(absent.is_absent() && !absent.is_null() && absent.as_option().is_none());
        assert!(!null.is_absent() && null.is_null() && null.as_option().is_none());
        assert!(!value.is_absent() && !value.is_null());
        assert_eq!(value.as_deref(), Some("local"));
        assert_ne!(absent, null);
        assert_eq!(
            OptionalNullable::<String>::default(),
            OptionalNullable::ABSENT
        );
        assert_eq!(
            OptionalNullable::from(None::<String>),
            OptionalNullable::NULL
        );
        assert_eq!(
            OptionalNullable::from(Some("x".to_owned())),
            OptionalNullable::some("x".to_owned())
        );
    }

    #[test]
    fn reads_absent_null_and_a_value_as_three_states() {
        #[derive(Debug, PartialEq, Serialize, Deserialize)]
        struct Holder {
            #[serde(default, skip_serializing_if = "OptionalNullable::is_absent")]
            executor_id: OptionalNullable<String>,
        }
        let absent: Holder = serde_json::from_value(json!({})).unwrap();
        let null: Holder = serde_json::from_value(json!({ "executor_id": null })).unwrap();
        let value: Holder = serde_json::from_value(json!({ "executor_id": "local" })).unwrap();
        assert_eq!(absent.executor_id, OptionalNullable::ABSENT);
        assert_eq!(null.executor_id, OptionalNullable::NULL);
        assert_eq!(
            value.executor_id,
            OptionalNullable::some("local".to_owned())
        );
        assert_eq!(serde_json::to_value(&absent).unwrap(), json!({}));
        assert_eq!(
            serde_json::to_value(&null).unwrap(),
            json!({ "executor_id": null })
        );
        assert_eq!(
            serde_json::to_value(&value).unwrap(),
            json!({ "executor_id": "local" })
        );
    }
}
