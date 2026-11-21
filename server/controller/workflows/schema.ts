export const WORKFLOW_SCHEMA_VERSION = 1;

export const WORKFLOW_SCHEMA = `
CREATE TABLE workflow_definitions (
  id TEXT PRIMARY KEY,
  latest_revision INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
) STRICT;
CREATE TABLE workflow_revisions (
  definition_id TEXT NOT NULL REFERENCES workflow_definitions(id),
  revision INTEGER NOT NULL,
  source TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  published_at TEXT NOT NULL,
  PRIMARY KEY (definition_id, revision)
) STRICT;
CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  definition_id TEXT,
  revision INTEGER,
  draft_json TEXT,
  inputs_json TEXT NOT NULL,
  context_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'waiting', 'attention', 'succeeded')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  operation_id TEXT UNIQUE,
  request_hash TEXT,
  signal_bytes INTEGER NOT NULL DEFAULT 0,
  binding_bytes INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (definition_id, revision) REFERENCES workflow_revisions(definition_id, revision),
  CHECK ((definition_id IS NULL AND revision IS NULL AND draft_json IS NOT NULL)
    OR (definition_id IS NOT NULL AND revision IS NOT NULL AND draft_json IS NULL))
) STRICT;
CREATE TABLE workflow_run_steps (
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  id TEXT NOT NULL,
  step_json TEXT NOT NULL,
  location_json TEXT,
  settings_json TEXT,
  executor_id TEXT,
  provider_id TEXT,
  max_concurrency INTEGER NOT NULL,
  intake TEXT NOT NULL CHECK (intake IN ('open', 'closed', 'skipped', 'blocked')),
  reason TEXT,
  close_sequence INTEGER,
  added INTEGER NOT NULL CHECK (added IN (0, 1)),
  PRIMARY KEY (run_id, id)
) STRICT;
CREATE INDEX workflow_steps_executor ON workflow_run_steps(executor_id) WHERE executor_id IS NOT NULL;
CREATE INDEX workflow_steps_provider ON workflow_run_steps(provider_id) WHERE provider_id IS NOT NULL;
CREATE TABLE workflow_instances (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  key TEXT,
  trigger_json TEXT NOT NULL,
  trigger_sequence INTEGER,
  is_repeated INTEGER NOT NULL CHECK (is_repeated IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('ready', 'running', 'waiting-executor', 'awaiting-decision', 'succeeded', 'failed', 'unknown', 'blocked')),
  reason TEXT,
  bindings_json TEXT,
  prompt TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (run_id, step_id) REFERENCES workflow_run_steps(run_id, id)
) STRICT;
CREATE INDEX workflow_instances_step ON workflow_instances(run_id, step_id);
CREATE INDEX workflow_instances_ready ON workflow_instances(status) WHERE status IN ('ready', 'waiting-executor');
CREATE INDEX workflow_instances_running ON workflow_instances(run_id, step_id) WHERE status = 'running';
CREATE TABLE workflow_attempts (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES workflow_instances(id),
  number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'unknown', 'unavailable')),
  chat_id TEXT UNIQUE,
  turn_id TEXT,
  chat_removed INTEGER NOT NULL DEFAULT 0 CHECK (chat_removed IN (0, 1)),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  reason TEXT,
  UNIQUE (instance_id, number)
) STRICT;
CREATE INDEX workflow_attempts_live ON workflow_attempts(status) WHERE status = 'running';
CREATE INDEX workflow_attempts_active_chats ON workflow_attempts(chat_id)
  WHERE chat_id IS NOT NULL AND chat_removed = 0 AND status IN ('running', 'failed', 'unknown');
CREATE TABLE workflow_signals (
  sequence INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  instance_id TEXT REFERENCES workflow_instances(id),
  signal TEXT NOT NULL,
  key TEXT NOT NULL,
  scope TEXT NOT NULL,
  payload_json TEXT,
  source_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id, step_id) REFERENCES workflow_run_steps(run_id, id),
  UNIQUE (run_id, scope, signal, key)
) STRICT;
CREATE INDEX workflow_signals_run ON workflow_signals(run_id, sequence);
CREATE INDEX workflow_signals_instance ON workflow_signals(instance_id, signal);
CREATE TABLE workflow_operations (
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_id TEXT NOT NULL,
  amendment_json TEXT,
  PRIMARY KEY (run_id, id)
) STRICT;
`;
