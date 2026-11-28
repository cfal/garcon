use garcon_agent_codex::{
    app_server::runtime_support::NoopLogger, history_loader::load_codex_chat_messages,
};
use garcon_contract::chat_types::ChatMessage;
use garcon_interface::native_message_source::get_native_message_revision_source;
use serde_json::{Value, json};

#[tokio::test]
async fn long_legacy_rollout_yields_while_preserving_every_row() {
    use std::{cell::Cell, time::Duration};
    use tokio::time::{Instant, sleep};

    const TURNS: usize = 60_000;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("rollout.jsonl");
    let rollout = tokio::task::spawn_blocking(|| {
        use std::fmt::Write;
        let mut rollout = String::new();
        for index in 0..TURNS {
            let timestamp = "2026-01-01T00:00:00.000Z";
            writeln!(rollout, "{}\n{}", json!({
                "type":"event_msg", "timestamp":timestamp,
                "payload":{"type":"user_message","message":format!("Synthetic request {index}")},
            }), json!({
                "type":"response_item", "timestamp":timestamp,
                "payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":format!("Synthetic answer {index}")}]},
            })).unwrap();
        }
        rollout
    }).await.unwrap();
    tokio::fs::write(&path, rollout).await.unwrap();
    let done = Cell::new(false);
    let loaded = async {
        let result = load_codex_chat_messages(path.to_str(), &NoopLogger, true, None).await;
        sleep(Duration::from_millis(5)).await;
        done.set(true);
        result.unwrap()
    };
    let probe = async {
        let mut last = Instant::now();
        let mut longest = Duration::ZERO;
        while !done.get() {
            sleep(Duration::from_millis(1)).await;
            let now = Instant::now();
            longest = longest.max(now - last);
            last = now;
        }
        longest
    };
    let (rows, longest) = tokio::join!(loaded, probe);
    assert_eq!(rows.len(), TURNS * 2);
    for (index, turn) in rows.as_chunks::<2>().0.iter().enumerate() {
        assert!(
            matches!(&turn[0].value, ChatMessage::User(message) if message.content == format!("Synthetic request {index}"))
        );
        assert!(
            matches!(&turn[1].value, ChatMessage::Assistant(message) if message.content == format!("Synthetic answer {index}"))
        );
    }
    assert!(
        longest < Duration::from_millis(50),
        "longest timer gap {longest:?}"
    );
}

#[tokio::test]
async fn legacy_history_matches_bun_in_rollout_order_and_fails_closed_for_invalid_imports() {
    let directory = tempfile::tempdir().unwrap();
    let at = "2026-01-01T00:00:00.000Z";
    let before = "2025-12-31T23:59:00.000Z";
    let response = |timestamp, payload| json!({"type":"response_item","timestamp":timestamp,"payload":payload});
    let rows = [
        response(
            at,
            json!({"type":"message","role":"user","content":[{"type":"input_text","text":"duplicated native input"}]}),
        ),
        json!({"type":"event_msg","timestamp":at,"payload":{"type":"user_message","message":"canonical input","client_id":" original "}}),
        response(
            at,
            json!({"type":"custom_tool_call","name":"exec","call_id":"command","input":"const result = await tools.exec_command({cmd: 'pwd'}); text(result.output);","internal_chat_message_metadata_passthrough":{"turn_id":"turn"}}),
        ),
        response(
            at,
            json!({"type":"function_call","name":"wait","call_id":"waiting","arguments":{"cell_id":"1"}}),
        ),
        response(
            at,
            json!({"type":"function_call_output","call_id":"waiting","output":"hidden result"}),
        ),
        response(
            at,
            json!({"type":"custom_tool_call_output","call_id":"command","output":"synthetic output","internal_chat_message_metadata_passthrough":{"turn_id":"turn"}}),
        ),
        response(
            before,
            json!({"type":"message","role":"assistant","id":"answer","content":[{"type":"output_text","text":"answer"}],"internal_chat_message_metadata_passthrough":{"turn_id":"turn"}}),
        ),
    ];
    let native = rows
        .iter()
        .map(|row| format!("{row}\n"))
        .collect::<String>();
    let malformed = format!("{native}{{");
    let wrong_part = format!(
        "{native}{}\n",
        response(
            at,
            json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":1}]})
        )
    );
    for (name, content) in [
        ("valid", native),
        ("malformed", malformed),
        ("wrong-part", wrong_part),
    ] {
        tokio::fs::write(directory.path().join(name), content)
            .await
            .unwrap();
    }
    let oracle = tokio::process::Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/oracles/history-loader.ts"
        ))
        .arg(directory.path())
        .output()
        .await
        .unwrap();
    assert!(
        oracle.status.success(),
        "{}",
        String::from_utf8_lossy(&oracle.stderr)
    );

    let mut output = Vec::new();
    for (name, strict) in [
        ("valid", true),
        ("malformed", true),
        ("malformed", false),
        ("wrong-part", true),
    ] {
        let path = directory.path().join(name);
        let loaded = load_codex_chat_messages(path.to_str(), &NoopLogger, strict, None).await;
        let value = match loaded {
            Ok(rows) => {
                if name == "valid" {
                    assert!(
                        matches!(&rows.first().unwrap().value, ChatMessage::User(user) if user.content == "canonical input")
                    );
                    assert!(
                        matches!(&rows.last().unwrap().value, ChatMessage::Assistant(assistant) if assistant.content == "answer"),
                        "history follows rollout order, not timestamps"
                    );
                }
                let rows = rows.iter().map(|row| {
                    json!({"message":row.value,"source":get_native_message_revision_source(row)})
                }).collect::<Vec<Value>>();
                json!({"messages": rows})
            }
            Err(error) => json!({"error":error.to_string()}),
        };
        output.push(value);
    }
    assert_eq!(serde_json::to_vec(&output).unwrap(), oracle.stdout);
}
