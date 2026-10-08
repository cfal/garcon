# Archive Undo

Archiving offers a temporary Undo action for the captured chats that are confirmed
archived after mutation settlement and list reconciliation. A partial batch failure
or a lost response can therefore still offer Undo for its confirmed archived subset.
An unconfirmed optimistic archive does not qualify.

Browser archive and restore operations use the existing typed
`PUT /api/v1/chats/archive` desired-state contract. Undo requests `isArchived: false`,
so a concurrent restore from another client cannot be reversed by a toggle.
Selection remains unchanged by Undo. The CLI already uses this PUT route through
both direct controller HTTP and the executor loopback gateway; its allowlist,
payload, authority, and executor protocol remain unchanged.

Sidebar rows, selected backgrounds, and separators share the same key-matched
virtual geometry while grouping changes settle.
