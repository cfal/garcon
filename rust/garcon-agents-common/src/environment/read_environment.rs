//! Ports `server-agents/common/src/environment/read-environment.ts`.

use garcon_interface::{host::AgentEnvironmentReader, resources::ExecutorResult};
use garcon_js::trim;

/// Returns the trimmed value of a variable, or `None` when it is unset or blank.
pub fn read_environment(
    environment: &dyn AgentEnvironmentReader,
    name: &str,
) -> ExecutorResult<Option<String>> {
    Ok(environment
        .get(name)?
        .as_deref()
        .map(trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned))
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    struct Reader<'a> {
        values: &'a [(&'a str, &'a str)],
        asked: RefCell<Vec<String>>,
        fail_on: Option<&'a str>,
    }

    impl AgentEnvironmentReader for Reader<'_> {
        fn get(&self, name: &str) -> ExecutorResult<Option<String>> {
            self.asked.borrow_mut().push(name.to_owned());
            if self.fail_on == Some(name) {
                return Err("environment unavailable".into());
            }
            Ok(self
                .values
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_owned()))
        }
    }

    #[test]
    fn trims_the_value_and_passes_the_name_unchanged() {
        let reader = Reader {
            values: &[("NAME", "  value\t\n")],
            asked: RefCell::default(),
            fail_on: None,
        };
        assert_eq!(
            read_environment(&reader, "NAME").unwrap().as_deref(),
            Some("value")
        );
        assert_eq!(*reader.asked.borrow(), ["NAME"]);
    }

    #[test]
    fn blank_and_unset_variables_read_as_absent() {
        let reader = Reader {
            values: &[("BLANK", " \u{a0}"), ("EMPTY", "")],
            asked: RefCell::default(),
            fail_on: None,
        };
        assert_eq!(read_environment(&reader, "BLANK").unwrap(), None);
        assert_eq!(read_environment(&reader, "EMPTY").unwrap(), None);
        assert_eq!(read_environment(&reader, "MISSING").unwrap(), None);
        assert_eq!(*reader.asked.borrow(), ["BLANK", "EMPTY", "MISSING"]);
    }

    #[test]
    fn a_failing_reader_fails_the_read() {
        let reader = Reader {
            values: &[],
            asked: RefCell::default(),
            fail_on: Some("NAME"),
        };
        assert_eq!(
            read_environment(&reader, "NAME").unwrap_err().to_string(),
            "environment unavailable"
        );
    }
}
