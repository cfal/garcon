# Machine picker UX

The shared executor menu currently presents names with an inline error only when a machine is unavailable. The menu should make the execution location and readiness readable before selection.

Retain the existing dropdown radio-menu contract, selected identity, refresh-on-open behavior, capability checks, and missing-selection handling. Add an Executor heading, Local/Remote icons, and a second line with location and service-specific status. Bound the menu to the viewport and use 44px minimum rows. Preserve compact toolbar/composer triggers and the existing responsive field placement.

A row menu scales better than a machine-card grid in narrow dialogs and avoids adding a second selection model. Readiness remains owned by ExecutorsStore; presentation cannot grant access. No HTTP, WebSocket, or executor protocol changes are needed.

Verify readiness changes while open, unavailable/missing selections, capability differences, keyboard selection, long labels, and desktop/mobile containment. Capture the real New Chat dialog before and after with synthetic machine identities.
