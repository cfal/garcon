import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentSettingsEnvelope } from '@garcon/common/agent-integration';
import type { AgentLegacySettingsScope } from '@garcon/server-agent-interface';
import { isRecord, type JsonObject, type JsonValue } from '@garcon/common/json';
import type { IntegrationRegistry } from './integration-registry.js';

const MIGRATION_ID = 'agent-integration-v1';
const CHAT_SCHEMA_VERSION = 3;
const CORE_RECORD_PATHS = new Set([
  'chats.json',
  'project-settings.json',
  'scheduled-prompts.json',
]);

interface MigrationFile {
  readonly relativePath: string;
  readonly existed: boolean;
  readonly backupSha256: string | null;
  readonly targetSha256: string;
}

interface MigrationManifest {
  readonly id: typeof MIGRATION_ID;
  readonly state: 'prepared' | 'committing' | 'committed';
  readonly files: readonly MigrationFile[];
}

export async function migrateAgentIntegrationCoreRecords(options: {
  workspaceDir: string;
  integrations: IntegrationRegistry;
  signal?: AbortSignal;
}): Promise<void> {
  const signal = options.signal ?? new AbortController().signal;
  const journalDir = path.join(options.workspaceDir, 'migration-journals', MIGRATION_ID);
  await recoverCoreRecordMigration(options.workspaceDir, journalDir);
  const targets = await createMigrationTargets(options.workspaceDir, options.integrations, signal);
  if (targets.length === 0) return;

  await fs.mkdir(journalDir, { recursive: true });
  const files: MigrationFile[] = [];
  for (const target of targets) {
    signal.throwIfAborted();
    const backupPath = journalPath(journalDir, 'backup', target.relativePath);
    const stagedPath = journalPath(journalDir, 'target', target.relativePath);
    await fs.mkdir(path.dirname(stagedPath), { recursive: true });
    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    const original = await fs.readFile(path.join(options.workspaceDir, target.relativePath)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (original) await writeDurable(backupPath, original);
    const encoded = Buffer.from(`${JSON.stringify(target.value, null, 2)}\n`);
    await writeDurable(stagedPath, encoded);
    files.push({
      relativePath: target.relativePath,
      existed: original !== null,
      backupSha256: original ? sha256(original) : null,
      targetSha256: sha256(encoded),
    });
  }
  await fsyncDirectory(journalDir);
  await writeManifest(journalDir, { id: MIGRATION_ID, state: 'prepared', files });
  await writeManifest(journalDir, { id: MIGRATION_ID, state: 'committing', files });
  await applyStagedTargets(options.workspaceDir, journalDir, files);
  await writeManifest(journalDir, { id: MIGRATION_ID, state: 'committed', files });
}

async function recoverCoreRecordMigration(workspaceDir: string, journalDir: string): Promise<void> {
  const manifest = await readManifest(journalDir);
  if (!manifest) return;
  if (manifest.state === 'committed') return;
  if (manifest.state === 'prepared') {
    await fs.rm(journalDir, { recursive: true, force: true });
    await fsyncDirectory(path.dirname(journalDir));
    return;
  }
  await applyStagedTargets(workspaceDir, journalDir, manifest.files);
  await writeManifest(journalDir, { ...manifest, state: 'committed' });
}

async function createMigrationTargets(
  workspaceDir: string,
  integrations: IntegrationRegistry,
  signal: AbortSignal,
): Promise<Array<{ relativePath: string; value: JsonValue }>> {
  const targets: Array<{ relativePath: string; value: JsonValue }> = [];
  const chats = await readJson(path.join(workspaceDir, 'chats.json'));
  if (isRecord(chats) && isRecord(chats.sessions) && needsChatMigration(chats)) {
    const sessions: Record<string, JsonValue> = {};
    for (const [chatId, value] of Object.entries(chats.sessions)) {
      signal.throwIfAborted();
      if (!isRecord(value)) throw new Error(`Invalid chat registry entry for ${chatId}`);
      const agentId = stringValue(value.agentId) ?? stringValue(value.provider);
      if (!agentId) throw new Error(`Chat ${chatId} has no integration ID`);
      const integration = integrations.require(agentId);
      const projectPath = stringValue(value.projectPath) ?? '';
      const model = stringValue(value.model) ?? '';
      const agentSessionId = stringValue(value.agentSessionId)
        ?? stringValue(value.providerSessionId);
      const shouldTranslateNativeSession = chats.version !== CHAT_SCHEMA_VERSION
        || 'provider' in value
        || 'providerSessionId' in value
        || 'nativePath' in value;
      const nativeSession = shouldTranslateNativeSession
        ? await integration.migration.translateLegacyNativeSession({
            chatId,
            projectPath,
            model,
            agentSessionId,
            legacyNativePath: stringValue(value.nativePath),
            legacyValues: value,
            signal,
          })
        : value.nativeSession ?? null;
      assertNativeSessionOwner(agentId, nativeSession);
      const agentSettingsById = await translateSettings(
        integrations,
        { kind: 'chat', recordId: chatId, selectedAgentId: agentId },
        value,
        signal,
      );
      sessions[chatId] = withoutKeys({
        ...value,
        agentId,
        agentSessionId,
        nativeSession: asJsonValue(nativeSession),
        agentSettingsById,
        agentOwnershipEpoch: stringValue(value.agentOwnershipEpoch) ?? crypto.randomUUID(),
      }, [
        'provider',
        'providerSessionId',
        'nativePath',
        'claudeThinkingMode',
        'ampAgentMode',
      ]);
    }
    targets.push({
      relativePath: 'chats.json',
      value: { ...chats, version: CHAT_SCHEMA_VERSION, sessions },
    });
  }

  const settings = await readJson(path.join(workspaceDir, 'project-settings.json'));
  if (isRecord(settings) && needsSettingsMigration(settings)) {
    const executionDefaults = isRecord(settings.executionDefaults) ? settings.executionDefaults : {};
    const global = isRecord(executionDefaults.global) ? executionDefaults.global : {};
    const legacyRootDefaults = legacyRootExecutionDefaults(settings);
    const migratedGlobal = await migrateExecutionDefaults(
      integrations,
      { ...legacyRootDefaults, ...global },
      { kind: 'execution-defaults', recordId: 'global', selectedAgentId: null },
      signal,
    );
    const byAgent: Record<string, JsonValue> = {};
    const rawByAgent = isRecord(executionDefaults.byAgent) ? executionDefaults.byAgent : {};
    const legacyAgentId = stringValue(settings.lastAgentId);
    const agentIds = new Set([
      ...Object.keys(rawByAgent),
      ...(legacyAgentId ? [legacyAgentId] : []),
    ]);
    for (const agentId of agentIds) {
      const value = rawByAgent[agentId];
      if (!isRecord(value)) continue;
      byAgent[agentId] = await migrateExecutionDefaults(
        integrations,
        agentId === legacyAgentId ? { ...legacyRootDefaults, ...value } : value,
        { kind: 'execution-defaults', recordId: agentId, selectedAgentId: agentId },
        signal,
      );
    }
    if (legacyAgentId && !isRecord(rawByAgent[legacyAgentId])) {
      byAgent[legacyAgentId] = await migrateExecutionDefaults(
        integrations,
        legacyRootDefaults,
        { kind: 'execution-defaults', recordId: legacyAgentId, selectedAgentId: legacyAgentId },
        signal,
      );
    }
    targets.push({
      relativePath: 'project-settings.json',
      value: withoutKeys({
        ...settings,
        executionDefaults: { global: migratedGlobal, byAgent },
      }, [
        'lastPermissionMode',
        'lastThinkingMode',
        'lastClaudeThinkingMode',
        'lastAmpAgentMode',
      ]),
    });
  }

  const scheduled = await readJson(path.join(workspaceDir, 'scheduled-prompts.json'));
  if (isRecord(scheduled) && Array.isArray(scheduled.prompts)) {
    let changed = false;
    const prompts: JsonValue[] = [];
    const scheduledPrompts: readonly JsonValue[] = scheduled.prompts;
    for (const candidate of scheduledPrompts) {
      if (!isRecord(candidate) || !isRecord(candidate.target) || candidate.target.type !== 'new-chat') {
        prompts.push(candidate as JsonValue);
        continue;
      }
      const target = candidate.target;
      const hasLegacySettings = 'claudeThinkingMode' in target || 'ampAgentMode' in target;
      if (isRecord(target.agentSettingsById) && !hasLegacySettings) {
        prompts.push(candidate);
        continue;
      }
      const agentId = stringValue(target.agentId);
      if (!agentId) throw new Error(`Scheduled prompt ${String(candidate.id)} has no integration ID`);
      const agentSettingsById = await translateSettings(
        integrations,
        { kind: 'scheduled-prompt', recordId: String(candidate.id), selectedAgentId: agentId },
        target,
        signal,
      );
      prompts.push({
        ...candidate,
        target: withoutKeys({ ...target, agentSettingsById }, ['claudeThinkingMode', 'ampAgentMode']),
      });
      changed = true;
    }
    if (changed) targets.push({
      relativePath: 'scheduled-prompts.json',
      value: { ...scheduled, prompts },
    });
  }
  return targets;
}

async function migrateExecutionDefaults(
  integrations: IntegrationRegistry,
  raw: JsonObject,
  scope: Parameters<typeof translateSettings>[1],
  signal: AbortSignal,
): Promise<JsonObject> {
  return withoutKeys({
    ...raw,
    agentSettingsById: await translateSettings(integrations, scope, raw, signal),
  }, ['claudeThinkingMode', 'ampAgentMode']);
}

async function translateSettings(
  integrations: IntegrationRegistry,
  scope: AgentLegacySettingsScope,
  legacyValues: JsonObject,
  signal: AbortSignal,
): Promise<JsonObject> {
  const existingById = isRecord(legacyValues.agentSettingsById)
    ? legacyValues.agentSettingsById
    : {};
  const result: Record<string, JsonValue> = {};
  for (const [agentId, value] of Object.entries(existingById)) {
    result[agentId] = asJsonValue(parseSettingsEnvelope(agentId, value));
  }
  for (const integration of integrations.list()) {
    signal.throwIfAborted();
    const agentId = integration.descriptor.id;
    const translated = await integration.migration.translateLegacySettings({ scope, legacyValues, signal });
    const existing = result[agentId];
    if (existing) {
      const migrated = await integration.settings.migrate(parseSettingsEnvelope(agentId, existing));
      const parsed = integration.settings.parse(migrated);
      assertSettingsOwner(agentId, parsed);
      result[agentId] = asJsonValue(parsed);
      continue;
    }
    if (!translated) continue;
    const parsed = integration.settings.parse(translated);
    assertSettingsOwner(agentId, parsed);
    result[agentId] = asJsonValue(parsed);
  }
  return result;
}

function parseSettingsEnvelope(agentId: string, value: JsonValue): AgentSettingsEnvelope {
  if (
    !isRecord(value)
    || value.ownerId !== agentId
    || typeof value.schemaVersion !== 'number'
    || !Number.isSafeInteger(value.schemaVersion)
    || value.schemaVersion < 1
    || !isRecord(value.values)
  ) {
    throw new Error(`Invalid settings envelope for integration ${agentId}`);
  }
  return {
    ownerId: value.ownerId,
    schemaVersion: value.schemaVersion,
    values: value.values,
  };
}

function assertSettingsOwner(agentId: string, envelope: AgentSettingsEnvelope): void {
  if (envelope.ownerId !== agentId) {
    throw new Error(`Integration ${agentId} returned settings owned by ${envelope.ownerId}`);
  }
}

function needsSettingsMigration(settings: JsonObject): boolean {
  const execution = isRecord(settings.executionDefaults) ? settings.executionDefaults : {};
  const records = [
    isRecord(execution.global) ? execution.global : {},
    ...Object.values(isRecord(execution.byAgent) ? execution.byAgent : {})
      .filter((value): value is JsonObject => isRecord(value)),
  ];
  return [
    'lastPermissionMode',
    'lastThinkingMode',
    'lastClaudeThinkingMode',
    'lastAmpAgentMode',
  ].some((key) => key in settings) || records.some((record) => (
    !isRecord(record.agentSettingsById)
    || 'claudeThinkingMode' in record
    || 'ampAgentMode' in record
  ));
}

function legacyRootExecutionDefaults(settings: JsonObject): JsonObject {
  const defaults: Record<string, JsonValue> = {};
  const keys = [
    ['lastPermissionMode', 'permissionMode'],
    ['lastThinkingMode', 'thinkingMode'],
    ['lastClaudeThinkingMode', 'claudeThinkingMode'],
    ['lastAmpAgentMode', 'ampAgentMode'],
  ] as const;
  for (const [legacyKey, targetKey] of keys) {
    if (legacyKey in settings) defaults[targetKey] = settings[legacyKey];
  }
  return defaults;
}

function needsChatMigration(chats: JsonObject): boolean {
  if (chats.version !== CHAT_SCHEMA_VERSION || !isRecord(chats.sessions)) return true;
  return Object.values(chats.sessions).some((candidate) => isRecord(candidate) && (
    'provider' in candidate
    || 'providerSessionId' in candidate
    || 'nativePath' in candidate
    || 'claudeThinkingMode' in candidate
    || 'ampAgentMode' in candidate
    || !isRecord(candidate.agentSettingsById)
    || typeof candidate.agentOwnershipEpoch !== 'string'
  ));
}

function assertNativeSessionOwner(agentId: string, value: unknown): void {
  if (value === null) return;
  if (
    !isRecord(value)
    || value.ownerId !== agentId
    || typeof value.schemaVersion !== 'number'
    || !Number.isSafeInteger(value.schemaVersion)
    || value.schemaVersion < 1
    || !isRecord(value.value)
  ) {
    throw new Error(`Integration ${agentId} returned an invalid native session reference`);
  }
}

async function applyStagedTargets(
  workspaceDir: string,
  journalDir: string,
  files: readonly MigrationFile[],
): Promise<void> {
  for (const file of files) {
    const staged = await fs.readFile(journalPath(journalDir, 'target', file.relativePath));
    if (sha256(staged) !== file.targetSha256) {
      throw new Error(`Core migration target checksum mismatch: ${file.relativePath}`);
    }
    await replaceDurable(path.join(workspaceDir, file.relativePath), staged);
  }
}

async function readJson(filePath: string): Promise<JsonValue | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as JsonValue;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function withoutKeys(value: JsonObject, keys: readonly string[]): JsonObject {
  const result = { ...value };
  for (const key of keys) delete result[key];
  return result;
}

function stringValue(value: JsonValue | undefined): string | null {
  return typeof value === 'string' && value ? value : null;
}

function journalPath(journalDir: string, kind: 'backup' | 'target', relativePath: string): string {
  return path.join(journalDir, kind, relativePath);
}

async function writeManifest(journalDir: string, manifest: MigrationManifest): Promise<void> {
  await replaceDurable(
    path.join(journalDir, 'manifest.json'),
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
  );
}

async function readManifest(journalDir: string): Promise<MigrationManifest | null> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(journalDir, 'manifest.json'), 'utf8')) as unknown;
    return parseManifest(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeDurable(filePath: string, contents: Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fs.open(filePath, 'w', 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncDirectory(path.dirname(filePath));
}

async function replaceDurable(filePath: string, contents: Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
  await writeDurable(temporary, contents);
  await fs.rename(temporary, filePath);
  await fsyncDirectory(path.dirname(filePath));
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function sha256(value: Uint8Array): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

function parseManifest(value: unknown): MigrationManifest {
  if (!isRecord(value) || value.id !== MIGRATION_ID || !['prepared', 'committing', 'committed'].includes(String(value.state))) {
    throw new Error('Invalid core migration manifest');
  }
  if (!Array.isArray(value.files)) throw new Error('Invalid core migration manifest');
  const seen = new Set<string>();
  const files: MigrationFile[] = value.files.map((candidate) => {
    if (!isRecord(candidate)) throw new Error('Invalid core migration manifest');
    const relativePath = typeof candidate.relativePath === 'string' ? candidate.relativePath : '';
    if (!CORE_RECORD_PATHS.has(relativePath) || seen.has(relativePath)) {
      throw new Error(`Invalid core migration path: ${relativePath}`);
    }
    seen.add(relativePath);
    const existed = candidate.existed;
    const backupSha256 = candidate.backupSha256;
    const targetSha256 = candidate.targetSha256;
    if (
      typeof existed !== 'boolean'
      || !(backupSha256 === null || isSha256(backupSha256))
      || !isSha256(targetSha256)
      || (existed !== (backupSha256 !== null))
    ) {
      throw new Error(`Invalid core migration metadata: ${relativePath}`);
    }
    return { relativePath, existed, backupSha256, targetSha256 };
  });
  return {
    id: MIGRATION_ID,
    state: value.state as MigrationManifest['state'],
    files,
  };
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
