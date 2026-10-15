# Sidebar machine hierarchy

When a remote executor is configured or appears in the chat list, grouped sidebar views show machines above their projects and chats. Machine headers use configured labels, connection status, chat counts, and a keyboard-accessible collapse button. Missing executors retain their durable identity and display Unavailable.

Machine order follows the executor catalog, with deterministic ordering for retained chats whose executor is absent. Project identity remains qualified by executor, so identical paths on different machines never merge. Activity and status sections belong to their machine; manual reorder scopes and next/previous navigation use the same visible row order.

Machine and per-machine section collapse preferences reuse the browser project-collapse store and its pruning lifecycle. Section keys become machine-qualified in multi-machine grouped views; existing global section preferences remain for Local-only and ungrouped views. No HTTP, WebSocket, executor protocol, or server persistence shape changes.

The Chromium regression uses an isolated controller and real remote worker, synthetic chats and two additional synthetic unavailable machines. It checks desktop/mobile rendering, connection labels, collapse persistence, keyboard expansion, and repeated Local/remote chat switching with a retained draft. GARCON_MACHINE_BASELINE=1 captures the same scenario against the unmodified base for comparison; GARCON_SCREENSHOT_DIR chooses the artifact directory.
