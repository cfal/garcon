use std::{path::Path, process::Command};

use garcon_chats::chat_transient_feed::{
    ChatTransientFeedStore, PermissionActionability, PermissionControl, TransientControlActionError,
};
use garcon_contract::{
    chat_transient_feed::{ChatTransientControlAction, ChatTransientFeedMutation},
    chat_types::{PermissionRequestMessage, ToolUseChatMessage},
};

const CHAT: &str = "1000000000000001";
const VIEW: &str = "view-1";
const AT: &str = "2026-08-11T00:00:00.000Z";

fn feed() -> ChatTransientFeedStore {
    ChatTransientFeedStore::new("server-1".into()).unwrap()
}

fn message(id: &str, reason: Option<&str>) -> PermissionRequestMessage {
    PermissionRequestMessage {
        timestamp: AT.into(),
        permission_occurrence_id: id.into(),
        requested_tool: ToolUseChatMessage::Bash {
            timestamp: AT.into(),
            tool_id: format!("tool-{id}"),
            command: "bun test".into(),
            description: None,
        },
        reason: reason.map(str::to_owned),
    }
}

fn request(
    feed: &ChatTransientFeedStore,
    id: &str,
    run_id: &str,
    reason: Option<&str>,
) -> ChatTransientFeedMutation {
    feed.permission_requested(CHAT, VIEW, Some(run_id), 3, message(id, reason))
        .unwrap()
        .unwrap()
}

fn action(id: &str) -> ChatTransientControlAction {
    ChatTransientControlAction {
        server_instance_id: "server-1".into(),
        chat_id: CHAT.into(),
        run_id: "run-1".into(),
        permission_occurrence_id: id.into(),
    }
}

fn control(id: &str) -> PermissionControl<'_> {
    PermissionControl {
        chat_id: CHAT,
        view_id: VIEW,
        run_id: "run-1",
        occurrence_id: id,
    }
}

#[test]
fn transient_feed_mutations_and_snapshots_match_bun_bytes() {
    let output = Command::new("bun")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/oracles/chat-transient-feed.ts"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let feed = feed();
    let mut lines = Vec::new();
    macro_rules! emit {
        ($value:expr) => {
            lines.push(serde_json::to_string(&$value).unwrap())
        };
    }
    emit!(feed.snapshot(CHAT, VIEW).unwrap());
    emit!(feed.current_snapshot(CHAT));
    emit!(request(
        &feed,
        "Z",
        "run-1",
        Some("Synthetic permission reason")
    ));
    emit!(request(&feed, "a", "run-2", None));
    emit!(feed.apply_permission_actionability(&control("Z"), PermissionActionability::Claimed));
    emit!(feed.current_snapshot(CHAT));
    emit!(feed.run_ended(CHAT, VIEW, "run-1").unwrap());
    emit!(feed.apply_permission_actionability(&control("Z"), PermissionActionability::Actionable));
    emit!(feed.current_snapshot(CHAT));
    feed.replace_view(CHAT, "view-2");
    emit!(feed.current_snapshot(CHAT));
    assert_eq!(
        format!("{}\n", lines.join("\n")),
        String::from_utf8(output.stdout).unwrap()
    );
}

#[test]
fn keeps_claimed_controls_visible_while_withholding_pending_user_action_until_abandonment() {
    let feed = feed();
    request(&feed, "one", "run-1", None);
    let before = feed.current_snapshot(CHAT);
    let original = feed.validate_action(&action("one")).unwrap();
    let control = control("one");
    assert!(feed.has_pending_user_action(CHAT));
    assert!(feed.apply_permission_actionability(&control, PermissionActionability::Claimed));
    assert!(!feed.has_pending_user_action(CHAT));
    assert_eq!(feed.current_snapshot(CHAT), before);
    assert_eq!(feed.validate_action(&action("one")).unwrap(), original);
    assert!(!feed.apply_permission_actionability(&control, PermissionActionability::Claimed));
    for stale in [
        PermissionControl {
            chat_id: "other",
            ..control
        },
        PermissionControl {
            view_id: "stale-view",
            ..control
        },
        PermissionControl {
            run_id: "stale-run",
            ..control
        },
        PermissionControl {
            occurrence_id: "unknown",
            ..control
        },
    ] {
        assert!(!feed.apply_permission_actionability(&stale, PermissionActionability::Actionable));
        assert!(feed.retire_permission(&stale).is_none());
    }
    assert!(feed.apply_permission_actionability(&control, PermissionActionability::Actionable));
    assert!(feed.has_pending_user_action(CHAT));
    assert_eq!(feed.current_snapshot(CHAT), before);
}

#[test]
fn does_not_restore_a_claimed_control_after_its_occurrence_is_retired() {
    let retire_controls: [fn(&ChatTransientFeedStore); 5] = [
        |feed: &ChatTransientFeedStore| {
            feed.retire_permission(&control("one")).unwrap();
        },
        |feed: &ChatTransientFeedStore| {
            feed.permission_settled(CHAT, VIEW, "one").unwrap().unwrap();
        },
        |feed: &ChatTransientFeedStore| {
            feed.run_ended(CHAT, VIEW, "run-1").unwrap().unwrap();
        },
        |feed: &ChatTransientFeedStore| feed.replace_view(CHAT, "view-2"),
        |feed: &ChatTransientFeedStore| feed.delete_chat(CHAT),
    ];
    for retire in retire_controls {
        let feed = feed();
        request(&feed, "one", "run-1", None);
        assert!(
            feed.apply_permission_actionability(&control("one"), PermissionActionability::Claimed)
        );
        retire(&feed);
        assert!(
            !feed.apply_permission_actionability(
                &control("one"),
                PermissionActionability::Actionable
            )
        );
        assert!(!feed.has_pending_user_action(CHAT));
        assert_eq!(
            feed.validate_action(&action("one")).unwrap_err(),
            TransientControlActionError::Stale
        );
    }
}

#[test]
fn rejects_stale_server_run_and_occurrence_action_fences() {
    let feed = feed();
    request(&feed, "one", "run-1", None);
    for (action, expected) in [
        (
            ChatTransientControlAction {
                server_instance_id: "old".into(),
                ..action("one")
            },
            TransientControlActionError::ServerRestarted,
        ),
        (
            ChatTransientControlAction {
                run_id: "old".into(),
                ..action("one")
            },
            TransientControlActionError::Stale,
        ),
        (action("unknown"), TransientControlActionError::Stale),
    ] {
        assert_eq!(feed.validate_action(&action).unwrap_err(), expected);
    }
}

#[test]
fn does_not_retarget_live_controls_but_resets_an_empty_snapshot_to_the_requested_view() {
    let feed = feed();
    request(&feed, "one", "run-1", None);
    assert_eq!(
        feed.snapshot(CHAT, "view-2").unwrap_err().message,
        "Transient feed snapshot does not match the current transcript view"
    );
    assert_eq!(
        feed.run_ended(CHAT, "view-2", "run-1").unwrap_err().message,
        "Cannot replace a transient feed with active controls"
    );
    assert!(feed.run_ended(CHAT, VIEW, "unknown").unwrap().is_none());
    assert_eq!(
        feed.retire_permission(&control("one"))
            .unwrap()
            .transient_revision,
        2
    );
    assert_eq!(feed.snapshot(CHAT, "view-2").unwrap().transient_revision, 0);
}
