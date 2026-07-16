# Dogfood Report: PR 260 Chat Transcript Search

| Field | Value |
|-------|-------|
| **Date** | 2026-07-08 |
| **App URL** | http://127.0.0.1:37537 |
| **Session** | garcon-chat-search-pr |
| **Scope** | Fresh rebuilt server pass for PR #260 transcript search |

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 0 |
| **Total** | **0** |

No transcript-search issues were found in the second focused pass.

## Scenarios

- Opened the search dialog from the sidebar on a fresh server.
  - Screenshot: `screenshots/02-dialog-open.png`
- Searched for `argument-length limit project:garcon`, a phrase from the chat body.
  - Result: returned `Chat Search Scope` with an `ASSISTANT` transcript snippet.
  - Screenshot: `screenshots/03-transcript-query.png`
- Searched for `argument-length limit project:pm-mm-rs`.
  - Result: displayed `No matching chats` and called `POST /api/v1/chats/search` with a 200 response.
  - Screenshot: `screenshots/04-negative-filter.png`
- Restored `argument-length limit project:garcon` and selected the result.
  - Result: navigated to `/chat/1783488418014199`.
  - Screenshots: `screenshots/05-positive-before-open.png`, `screenshots/06-opened-result.png`
