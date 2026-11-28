use garcon_cases::{CaseError, unknown};
use garcon_contract::agent_cli_update::{
    parse_agent_cli_update_status, parse_agent_cli_updates_response,
};

use crate::helpers::{plain, recorded_cases};

#[test]
fn agent_cli_update_cases_match() {
    recorded_cases(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/agent-cli-update"
        ),
        "common/agent-cli-update.ts",
        |function, args| {
            let value = unknown(function, args.first())?;
            match function {
                "parseAgentCliUpdateStatus" => Ok(plain(parse_agent_cli_update_status(&value))),
                "parseAgentCliUpdatesResponse" => {
                    Ok(plain(parse_agent_cli_updates_response(&value)))
                }
                _ => Err(CaseError::unhandled(function)),
            }
        },
    );
}
