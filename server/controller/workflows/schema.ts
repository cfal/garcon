export const WORKFLOW_SCHEMA_VERSION = 2;

export const WORKFLOW_SCHEMA = [
`CREATE TABLE workflow_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton=1),
  store_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision>=0),
  admission_epoch INTEGER NOT NULL CHECK (admission_epoch>=0)
) STRICT`,
`CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision>0),
  desired TEXT NOT NULL CHECK (desired IN ('draft','active','paused','canceled')),
  draft_plan_revision INTEGER NOT NULL,
  active_plan_revision INTEGER,
  admission_epoch INTEGER NOT NULL,
  control_epoch INTEGER NOT NULL,
  title TEXT NOT NULL,
  captain_chat_id TEXT,
  archived INTEGER NOT NULL CHECK (archived IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT`,
`CREATE TABLE plan_revisions (
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  revision INTEGER NOT NULL,
  digest TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  PRIMARY KEY (workflow_id,revision)
) STRICT`,
`CREATE TABLE tasks (
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation>0),
  input_digest TEXT,
  hold TEXT NOT NULL CHECK (hold IN ('none','intervention','output-unknown')),
  hold_reason TEXT,
  next_eligible_at TEXT,
  PRIMARY KEY (workflow_id,id)
) STRICT`,
`CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL,
  generation INTEGER NOT NULL CHECK (generation>0),
  input_digest TEXT NOT NULL,
  dispatch_phase TEXT NOT NULL CHECK (dispatch_phase IN ('planned','preparing','prepared','dispatching','observed-running','settled')),
  resolution TEXT NOT NULL CHECK (resolution IN ('open','succeeded','failed','interrupted','not-started','unknown','abandoned')),
  control_state TEXT NOT NULL CHECK (control_state IN ('leased','revoked','released')),
  revocation_reason TEXT,
  revocation_kind TEXT CHECK (revocation_kind IN ('intervention','superseded')),
  admission_failure INTEGER NOT NULL DEFAULT 0 CHECK (admission_failure IN (0,1)),
  request_id TEXT NOT NULL UNIQUE,
  server_instance_id TEXT,
  chat_id TEXT,
  turn_id TEXT,
  target_json TEXT NOT NULL,
  result_json TEXT,
  effective_input_json TEXT,
  managed_target_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (workflow_id,task_id) REFERENCES tasks(workflow_id,id),
  FOREIGN KEY (workflow_id,plan_revision) REFERENCES plan_revisions(workflow_id,revision)
) STRICT`,
`CREATE UNIQUE INDEX one_unsettled_attempt ON attempts(workflow_id,task_id) WHERE resolution IN ('open','unknown') OR control_state='leased' OR dispatch_phase!='settled'`,
`CREATE INDEX attempts_workflow ON attempts(workflow_id,created_at,id)`,
`CREATE INDEX attempts_task_generation ON attempts(workflow_id,task_id,generation)`,
`CREATE INDEX attempts_pending ON attempts(id) WHERE resolution IN ('open','unknown') OR control_state='leased' OR dispatch_phase!='settled'`,
`CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  payload_json TEXT NOT NULL
) STRICT`,
`CREATE INDEX artifacts_attempt ON artifacts(attempt_id)`,
`CREATE TABLE approvals (
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  gate_id TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (workflow_id,gate_id,manifest_digest)
) STRICT`,
`CREATE TABLE operation_intents (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  kind TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned','dispatching','succeeded','not-started','unknown','abandoned')),
  payload_json TEXT NOT NULL,
  result_json TEXT,
  reconcile_count INTEGER NOT NULL,
  next_reconcile_at TEXT
) STRICT`,
`CREATE TABLE gate_manifests (
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  gate_id TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (workflow_id,gate_id)
) STRICT`,
`CREATE INDEX operation_intents_attempt ON operation_intents(attempt_id)`,
`CREATE TABLE resource_claims (
  resource_key TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  executor_id TEXT NOT NULL,
  quarantined INTEGER NOT NULL CHECK (quarantined IN (0,1)),
  risk_released INTEGER NOT NULL CHECK (risk_released IN (0,1)),
  retained INTEGER NOT NULL DEFAULT 0 CHECK (retained IN (0,1))
) STRICT`,
`CREATE INDEX resource_claims_attempt ON resource_claims(attempt_id)`,
`CREATE INDEX resource_claims_capacity ON resource_claims(attempt_id) WHERE risk_released=0 AND retained=0`,
`CREATE INDEX workflows_active ON workflows(id) WHERE archived=0 AND desired='active'`,
`CREATE TABLE activity (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  detail TEXT NOT NULL,
  at TEXT NOT NULL
) STRICT`,
`CREATE INDEX activity_workflow ON activity(workflow_id,sequence DESC)`,
`CREATE TABLE mutation_results (
  operation_id TEXT PRIMARY KEY,
  authority_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL
) STRICT`,
`PRAGMA user_version=${WORKFLOW_SCHEMA_VERSION}`,
] as const;
