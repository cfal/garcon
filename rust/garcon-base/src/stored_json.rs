use garcon_js::json::Opaque;

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
#[error("{subject} is not valid JSON")]
pub struct MalformedStoredJsonError {
    pub subject: String,
}

pub fn parse_stored_json(text: &str, subject: &str) -> Result<Opaque, MalformedStoredJsonError> {
    Opaque::parse(text).map_err(|_| MalformedStoredJsonError {
        subject: subject.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_stored_json() {
        let parsed = parse_stored_json(r#"{"synthetic":true}"#, "synthetic.json").unwrap();
        assert_eq!(parsed["synthetic"], true);
    }

    #[test]
    fn names_stored_json_that_fails_to_parse_without_echoing_it() {
        let error =
            parse_stored_json(r#"{"secret": SYNTHETIC_SENTINEL}"#, "synthetic.json").unwrap_err();
        assert_eq!(error.subject, "synthetic.json");
        assert_eq!(error.to_string(), "synthetic.json is not valid JSON");
        assert!(!format!("{error:?}").contains("SYNTHETIC_SENTINEL"));
    }
}
