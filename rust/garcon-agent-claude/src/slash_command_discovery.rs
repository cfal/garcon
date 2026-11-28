use std::collections::HashSet;

use garcon_contract::slash_commands::{SlashCommand, SlashCommandSource};
use garcon_js::collation::Collation;
use serde_json::Value;

pub fn parse_init_slash_commands(slash_commands: &Value, skills: &Value) -> Vec<SlashCommand> {
    let skill_names: HashSet<&str> = skills
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let Some(slash_commands) = slash_commands.as_array() else {
        return Vec::new();
    };

    let mut commands: Vec<_> = slash_commands
        .iter()
        .filter_map(|value| {
            let (name, description, explicit_skill) = match value {
                Value::String(name) => (name.as_str(), None, false),
                Value::Object(fields) => (
                    fields.get("name")?.as_str()?,
                    fields
                        .get("description")
                        .and_then(Value::as_str)
                        .filter(|text| !text.is_empty())
                        .map(str::to_owned),
                    fields.get("type").and_then(Value::as_str) == Some("skill"),
                ),
                _ => return None,
            };
            // A native clear would discard context that the ledger still describes.
            if name == "clear" {
                return None;
            }
            let source = if explicit_skill || skill_names.contains(name) {
                SlashCommandSource::Skill
            } else {
                SlashCommandSource::Command
            };
            Some(SlashCommand {
                name: name.to_owned(),
                source,
                description,
            })
        })
        .collect();
    commands.sort_by(|left, right| Collation::english().compare(&left.name, &right.name));
    commands
}
