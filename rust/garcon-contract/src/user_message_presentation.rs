//! Ports `common/user-message-presentation.ts`.

use garcon_js::array_index;
use serde::{Serialize, Serializer};
use serde_json::{Map, Value};

use crate::chat_row_contracts::parse_chat_row_title;
use crate::cli_presentation::{
    CliBodyDisclosure, CliPresentation, is_cli_body_disclosure, is_cli_presentation,
};
use crate::command_request_validation::CommandRequestValidationError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UserMessagePresentation {
    Styled {
        presentation: CliPresentation,
        title: Option<String>,
        collapsed: bool,
    },
    Collapsed,
}

impl Serialize for UserMessagePresentation {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct WirePresentation<'a> {
            origin: &'static str,
            #[serde(flatten)]
            presentation: Option<&'a CliPresentation>,
            #[serde(skip_serializing_if = "Option::is_none")]
            title: Option<&'a str>,
            #[serde(skip_serializing_if = "Option::is_none")]
            disclosure: Option<CliBodyDisclosure>,
        }
        let (presentation, title, collapsed) = match self {
            Self::Styled {
                presentation,
                title,
                collapsed,
            } => (Some(presentation), title.as_deref(), *collapsed),
            Self::Collapsed => (None, None, true),
        };
        WirePresentation {
            origin: "cli",
            presentation,
            title,
            disclosure: collapsed.then_some(CliBodyDisclosure::Collapsed),
        }
        .serialize(serializer)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum UserMessagePresentationError {
    #[error("user message presentation must be an object")]
    NotObject,
    #[error("user message presentation contains unsupported field: {0}")]
    UnsupportedField(String),
    #[error("user message presentation origin must be cli")]
    Origin,
    #[error("user message presentation disclosure is invalid")]
    Disclosure,
    #[error("styleless user message presentation must be collapsed")]
    ExpandedStyleless,
    #[error("styleless user message presentation cannot carry a title or custom style")]
    StyledFieldsWithoutStyle,
    #[error("user message presentation is invalid")]
    Style,
    #[error(transparent)]
    Title(#[from] CommandRequestValidationError),
}

impl UserMessagePresentationError {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Title(_) => "CommandRequestValidationError",
            _ => "TypeError",
        }
    }
}

pub fn parse_user_message_presentation(
    value: Option<&Value>,
) -> Result<Option<UserMessagePresentation>, UserMessagePresentationError> {
    use UserMessagePresentationError as Error;
    let Some(value) = value else { return Ok(None) };
    let body = value.as_object().ok_or(Error::NotObject)?;
    if let Some(key) = body
        .keys()
        .filter(|key| {
            !matches!(
                key.as_str(),
                "origin" | "style" | "customStyle" | "title" | "disclosure"
            )
        })
        .min_by_key(|key| array_index(key).unwrap_or(u64::MAX))
    {
        return Err(Error::UnsupportedField(key.clone()));
    }
    if value["origin"] != "cli" {
        return Err(Error::Origin);
    }
    let disclosure = body
        .get("disclosure")
        .map(|value| is_cli_body_disclosure(value).ok_or(Error::Disclosure))
        .transpose()?;
    let title = parse_chat_row_title(&value["title"])?;
    let collapsed = disclosure == Some(CliBodyDisclosure::Collapsed);
    let Some(style) = body.get("style") else {
        if !collapsed {
            return Err(Error::ExpandedStyleless);
        }
        if body.contains_key("customStyle") || title.is_some() {
            return Err(Error::StyledFieldsWithoutStyle);
        }
        return Ok(Some(UserMessagePresentation::Collapsed));
    };
    let mut presentation = Map::new();
    presentation.insert("style".into(), style.clone());
    if let Some(custom) = body.get("customStyle") {
        presentation.insert("customStyle".into(), custom.clone());
    }
    let presentation = is_cli_presentation(&Value::Object(presentation)).ok_or(Error::Style)?;
    Ok(Some(UserMessagePresentation::Styled {
        presentation,
        title: title.map(str::to_owned),
        collapsed,
    }))
}
