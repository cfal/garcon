# Dogfood Report: Garcon Chat Transcript Search

| Field | Value |
|-------|-------|
| **Date** | 2026-07-08 |
| **App URL** | http://127.0.0.1:36931 |
| **Session** | garcon-chat-search |
| **Scope** | Search dialog transcript search, snippets, structured project filters, and result navigation |

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 0 |
| **Total** | **0** |

No transcript-search issues were found in this focused pass.

## Scenarios

- Opened the chat search dialog from the sidebar.
  - Screenshot: `screenshots/04-search-dialog-open.png`
- Searched for `stale snippet`, a phrase from the current chat transcript rather than the chat title.
  - Result: returned `Chat Search Scope` with an `ASSISTANT` transcript snippet.
  - Screenshot: `screenshots/05-transcript-query-stale-snippet.png`
- Searched for `stale snippet project:garcon`.
  - Result: returned Garcon project transcript matches and called `POST /api/v1/chats/search` with a 200 response.
  - Screenshot: `screenshots/06-transcript-query-project-filter.png`
- Searched for `stale snippet project:pm-mm-rs`.
  - Result: displayed `No matching chats`, confirming project filtering excluded the Garcon transcript hit.
  - Screenshot: `screenshots/07-negative-project-filter.png`
- Selected the `Chat Search Scope` transcript match from the dialog.
  - Result: navigated to `/chat/1783488418014199` and opened the matching chat.
  - Screenshots: `screenshots/08-before-result-open.png`, `screenshots/09-result-opened.png`

## Notes

- The app showed an existing PR pane message: `gh pr failed (exit 1): failed to run git: [git-guard] blocked...`. This appears environmental and unrelated to transcript search.
- No console failure was observed during the tested flow.
