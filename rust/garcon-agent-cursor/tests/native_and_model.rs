use garcon_agent_cursor::{
    cursor_acp_model_config::{assignments_for_cursor_model, cursor_config_selection_for_model},
    cursor_native_path::{
        create_cursor_acp_native_path, get_cursor_acp_agent_session_id_from_native_path,
        get_cursor_agent_session_id_from_native_path,
        get_cursor_stream_json_agent_session_id_from_native_path,
    },
};
use garcon_cases::{CaseError, replay, text, unknown};
use serde_json::{Value, json};

#[test]
fn cursor_model_selection_matches_bun() {
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/acp-model-config"),
        |function, args| {
            let model = text(function, args.first())?
                .ok_or_else(|| CaseError::undeliverable("model must be a string"))?;
            match function {
                "cursorConfigSelectionForModel" => {
                    Ok(cursor_config_selection_for_model(model).unwrap_or(Value::Null))
                }
                "assignmentsForCursorModel" => Ok(
                    match assignments_for_cursor_model(model, text(function, args.get(1))?) {
                        Ok(assignments) => json!(assignments),
                        Err(error) => {
                            json!({"$":"error","name":"Error","message":error.to_string(),"properties":{}})
                        }
                    },
                ),
                function => Err(CaseError::unhandled(function)),
            }
        },
    );
}

#[test]
fn cursor_native_paths_match_bun() {
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/native-path"),
        |function, args| {
            let path = unknown(function, args.first())?;
            Ok(json!(match function {
                "createCursorAcpNativePath" =>
                    create_cursor_acp_native_path(text(function, args.first())?),
                "getCursorAcpAgentSessionIdFromNativePath" =>
                    get_cursor_acp_agent_session_id_from_native_path(&path),
                "getCursorStreamJsonAgentSessionIdFromNativePath" =>
                    get_cursor_stream_json_agent_session_id_from_native_path(&path),
                "getCursorAgentSessionIdFromNativePath" =>
                    get_cursor_agent_session_id_from_native_path(&path),
                function => return Err(CaseError::unhandled(function)),
            }))
        },
    );
}
