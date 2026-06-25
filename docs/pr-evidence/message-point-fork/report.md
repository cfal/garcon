# Dogfood Report: Message-Point Fork

Target URL: http://127.0.0.1:39489/chat/1
Session: garcon-message-point-fork
Date: 2026-06-24
Scope: Verify selected-message fork on isolated Garcon server seeded with Claude JSONL, including incomplete active tail.

## Summary

- Issues found: 0
- Result: PASS

## Evidence

- `screenshots/initial-chat.png`: Source chat renders four completed messages; incomplete fifth JSONL line is not rendered.
- `screenshots/fork-menu-open.png`: First message three-dot menu exposes `Fork`.
- `screenshots/forked-chat.png`: Forked chat opens and renders only the first message.

## Functional Verification

After clicking `Fork` from the first message menu:

- New chat id: `1782269882890899`
- Forked JSONL line count: `1`
- Contains first prompt: `true`
- Contains second prompt: `false`
- Contains tail response: `false`
- Contains incomplete active tail: `false`
- Forked JSONL parses as valid JSONL: `true`

## Console

No browser errors were observed during the flow.
