export const TICKET_SCHEMA_V1 = [
`CREATE TABLE ticket_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  store_id TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL
) STRICT`,
`CREATE TABLE tickets (
  number INTEGER PRIMARY KEY AUTOINCREMENT,
  revision INTEGER NOT NULL,
  project TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','in-progress','in-review','closed')),
  resolution TEXT CHECK (resolution IN ('done','canceled')),
  priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 3),
  assignee_key TEXT,
  parent_number INTEGER REFERENCES tickets(number),
  payload_json TEXT NOT NULL,
  CHECK ((status = 'closed' AND resolution IS NOT NULL) OR (status <> 'closed' AND resolution IS NULL))
) STRICT`,
`CREATE INDEX tickets_project_status ON tickets(project, status, number DESC)`,
`CREATE INDEX tickets_status ON tickets(status, number DESC)`,
`CREATE INDEX tickets_assignee ON tickets(assignee_key, number DESC)`,
`CREATE INDEX tickets_parent ON tickets(parent_number, number DESC)`,
`CREATE TABLE ticket_labels (
  ticket_number INTEGER NOT NULL REFERENCES tickets(number),
  label TEXT NOT NULL,
  PRIMARY KEY (ticket_number, label)
) WITHOUT ROWID, STRICT`,
`CREATE INDEX ticket_labels_lookup ON ticket_labels(label, ticket_number DESC)`,
`CREATE TABLE ticket_links (
  source_number INTEGER NOT NULL REFERENCES tickets(number),
  target_number INTEGER NOT NULL REFERENCES tickets(number),
  kind TEXT NOT NULL CHECK (kind IN ('blocks','related')),
  CHECK (source_number <> target_number),
  PRIMARY KEY (source_number, target_number, kind)
) WITHOUT ROWID, STRICT`,
`CREATE INDEX ticket_links_target ON ticket_links(target_number, kind, source_number)`,
`CREATE TABLE ticket_comments (
  id TEXT PRIMARY KEY,
  ticket_number INTEGER NOT NULL REFERENCES tickets(number),
  sequence INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  authority_key TEXT NOT NULL,
  deleted_at TEXT,
  payload_json TEXT NOT NULL,
  UNIQUE(ticket_number, sequence)
) STRICT`,
`CREATE INDEX ticket_comments_visible ON ticket_comments(ticket_number, sequence DESC) WHERE deleted_at IS NULL`,
`CREATE TABLE ticket_activity (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_number INTEGER NOT NULL REFERENCES tickets(number),
  operation_key TEXT NOT NULL,
  payload_json TEXT NOT NULL
) STRICT`,
`CREATE INDEX ticket_activity_page ON ticket_activity(ticket_number, sequence DESC)`,
`CREATE TABLE ticket_operations (
  operation_key TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  result_json TEXT NOT NULL
) STRICT`,
`PRAGMA user_version = 1`,
] as const;
