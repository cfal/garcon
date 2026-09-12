export const ISSUE_SCHEMA = `
CREATE TABLE issue_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  store_id TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL
) STRICT;
CREATE TABLE issues (
  number INTEGER PRIMARY KEY AUTOINCREMENT,
  revision INTEGER NOT NULL,
  project TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','in-progress','in-review','closed')),
  resolution TEXT CHECK (resolution IN ('done','canceled')),
  priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 3),
  assignee_key TEXT,
  parent_number INTEGER REFERENCES issues(number),
  payload_json TEXT NOT NULL,
  CHECK ((status = 'closed' AND resolution IS NOT NULL) OR (status <> 'closed' AND resolution IS NULL))
) STRICT;
CREATE INDEX issues_project_status ON issues(project, status, number DESC);
CREATE INDEX issues_status ON issues(status, number DESC);
CREATE INDEX issues_assignee ON issues(assignee_key, number DESC);
CREATE INDEX issues_parent ON issues(parent_number, number DESC);
CREATE TABLE issue_labels (
  issue_number INTEGER NOT NULL REFERENCES issues(number),
  label TEXT NOT NULL,
  PRIMARY KEY (issue_number, label)
) WITHOUT ROWID, STRICT;
CREATE INDEX issue_labels_lookup ON issue_labels(label, issue_number DESC);
CREATE TABLE issue_links (
  source_number INTEGER NOT NULL REFERENCES issues(number),
  target_number INTEGER NOT NULL REFERENCES issues(number),
  kind TEXT NOT NULL CHECK (kind IN ('blocks','related')),
  CHECK (source_number <> target_number),
  PRIMARY KEY (source_number, target_number, kind)
) WITHOUT ROWID, STRICT;
CREATE INDEX issue_links_target ON issue_links(target_number, kind, source_number);
CREATE TABLE issue_comments (
  id TEXT PRIMARY KEY,
  issue_number INTEGER NOT NULL REFERENCES issues(number),
  sequence INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  authority_key TEXT NOT NULL,
  deleted_at TEXT,
  payload_json TEXT NOT NULL,
  UNIQUE(issue_number, sequence)
) STRICT;
CREATE INDEX issue_comments_visible ON issue_comments(issue_number, sequence DESC) WHERE deleted_at IS NULL;
CREATE TABLE issue_activity (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_number INTEGER NOT NULL REFERENCES issues(number),
  operation_key TEXT NOT NULL,
  payload_json TEXT NOT NULL
) STRICT;
CREATE INDEX issue_activity_page ON issue_activity(issue_number, sequence DESC);
CREATE TABLE issue_operations (
  operation_key TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  result_json TEXT NOT NULL
) STRICT;
PRAGMA user_version = 1;
`;
