use garcon_agent_claude::slash_command_discovery::parse_init_slash_commands;
use garcon_cases::{CaseError, replay, unknown};

#[test]
fn recorded_init_slash_command_cases_match() {
    replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/slash-command-discovery"
        ),
        |function, args| {
            if function != "parseInitSlashCommands" {
                return Err(CaseError::unhandled(function));
            }
            let slash_commands = unknown(function, args.first())?;
            let skills = unknown(function, args.get(1))?;
            let commands = parse_init_slash_commands(&slash_commands, &skills);
            Ok(garcon_js::json::from_slice(&serde_json::to_vec(&commands).unwrap()).unwrap())
        },
    );
}
