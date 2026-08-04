// Runs the real pinned OpenCode binary behind Garcon with its only enabled model pointed at
// FakeChatCompletionsModel. OpenCode's server, SDK endpoints, global event stream, prompt
// loop, tool execution, permission flow, SQLite persistence, fork behavior, and process
// lifecycle stay real; the fake controls only the model. Every OpenCode read and write lives
// below the fixture root: HOME, all XDG roots, TMPDIR, an explicit config and DB, a managed
// config redirect, empty auth, and a PATH shim that executes the test-only supervisor, which
// in turn runs only the pinned absolute binary. The user's real OpenCode config, auth, model
// history, sessions, managed config, and global executable are never touched.

import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSettingsEnvelope } from '../../common/agent-integration.js';
import type {
  AgentRunCommandRequest,
  StartChatCommandRequest,
} from '../../common/chat-command-contracts.js';
import { FakeChatCompletionsModel } from './fake-chat-completions-model.js';
import type { IntegrationDirectories } from './integration-fixture.js';
import {
  buildOpenCodeProviderEnvironment,
  PINNED_OPENCODE_VERSION,
  processIdentityAlive,
  readJsonFile,
  verifyPinnedBinaryVersion,
  writeJsonAtomic,
  type OpenCodeBinaryVerification,
  type OpenCodeProcessState,
} from './opencode-process-supervisor.js';

export const OPENCODE_VERSION = PINNED_OPENCODE_VERSION;
export const OPENCODE_BINARY = fileURLToPath(
  new URL('../node_modules/.bin/opencode', import.meta.url),
);
const SUPERVISOR_MODULE = fileURLToPath(
  new URL('./opencode-process-supervisor.ts', import.meta.url),
);

export const OPENCODE_TEST_PROVIDER = 'garcon-fake';
export const OPENCODE_TEST_MODEL_ID = 'fake-model';
export const OPENCODE_TEST_MODEL = `${OPENCODE_TEST_PROVIDER}/${OPENCODE_TEST_MODEL_ID}`;
export const OPENCODE_TEST_THINKING_MODE = 'none';

const SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

const OPENCODE_AGENT_SETTINGS: AgentSettingsEnvelope = {
  ownerId: 'opencode',
  schemaVersion: 1,
  values: {},
};

// OpenCode 1.18.4 schedules an @opencode-ai/plugin install for every config directory and
// skips reification only when node_modules exists and package.json plus package-lock.json
// already declare the pinned plugin. Seeding these bytes keeps provider runtime offline; the
// loopback npm registry trap turns any future attempt into an otherRequests() violation.
// https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/core/src/npm.ts#L131-L184
export const OPENCODE_PLUGIN_SEED_FILES: Record<string, string> = {
  'package.json': JSON.stringify({
    dependencies: { '@opencode-ai/plugin': OPENCODE_VERSION },
  }, null, 2),
  'package-lock.json': JSON.stringify({
    lockfileVersion: 3,
    packages: { '': { dependencies: { '@opencode-ai/plugin': OPENCODE_VERSION } } },
  }, null, 2),
  // Mirrors Config.ensureGitignore exactly so the seeded directory stays byte-identical.
  // https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/opencode/src/config/config.ts#L295-L309
  '.gitignore': ['node_modules', 'package.json', 'package-lock.json', 'bun.lock', '.gitignore'].join('\n'),
};

export interface OpenCodePaths {
  root: string;
  config: string;
  database: string;
  bin: string;
  verification: string;
  processState: string;
  proxy: string;
  xdgConfig: string;
  globalConfig: string;
  xdgData: string;
  xdgState: string;
  xdgCache: string;
  npmCache: string;
  managedConfig: string;
  temp: string;
}

export function openCodePaths(directories: IntegrationDirectories): OpenCodePaths {
  const root = join(directories.root, 'opencode');
  return {
    root,
    config: join(root, 'opencode.json'),
    database: join(root, 'opencode.db'),
    bin: join(root, 'bin'),
    verification: join(root, 'binary-verification.json'),
    processState: join(root, 'process-state'),
    proxy: join(root, 'proxy'),
    xdgConfig: join(root, 'xdg-config'),
    globalConfig: join(root, 'xdg-config', 'opencode'),
    xdgData: join(root, 'xdg-data'),
    xdgState: join(root, 'xdg-state'),
    xdgCache: join(root, 'xdg-cache'),
    npmCache: join(root, 'npm-cache'),
    managedConfig: join(root, 'managed-config'),
    temp: join(root, 'tmp'),
  };
}

function openCodeConfig(modelBaseUrl: string): Record<string, unknown> {
  return {
    formatter: false,
    lsp: false,
    enabled_providers: [OPENCODE_TEST_PROVIDER],
    model: OPENCODE_TEST_MODEL,
    small_model: OPENCODE_TEST_MODEL,
    agent: {
      title: { disable: true },
      summary: { disable: true },
    },
    provider: {
      [OPENCODE_TEST_PROVIDER]: {
        id: OPENCODE_TEST_PROVIDER,
        name: 'Garcon Fake',
        env: [],
        npm: '@ai-sdk/openai-compatible',
        models: {
          [OPENCODE_TEST_MODEL_ID]: {
            id: OPENCODE_TEST_MODEL_ID,
            name: 'Garcon Fake Model',
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: '2025-01-01',
            limit: { context: 100_000, output: 10_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: {
          apiKey: 'garcon-test-key',
          baseURL: `${modelBaseUrl}/v1`,
        },
      },
    },
  };
}

// Every mutable provider-state path must stay inside the fixture root. The only exceptions
// are the immutable pinned executable and the system command directories in PATH.
function assertFixtureOwnedPaths(paths: OpenCodePaths, fixtureRoot: string): void {
  const rootPrefix = fixtureRoot.endsWith(sep) ? fixtureRoot : `${fixtureRoot}${sep}`;
  for (const [name, value] of Object.entries(paths)) {
    if (name === 'root') continue;
    if (!value.startsWith(rootPrefix)) {
      throw new Error(`OpenCode path "${name}" escapes the fixture root: ${value}`);
    }
  }
}

// OpenCode 1.18.4 has no hermetic override for macOS managed-preference plist reads, so the
// real-binary tier runs on Linux only; unit coverage remains cross-platform.
export function assertScriptedOpenCodePlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'linux') {
    throw new Error(
      `Scripted OpenCode integration tests require Linux; ${platform} cannot isolate managed preferences.`,
    );
  }
}

export interface ScriptedOpenCodeTestEnvironment {
  readonly model: FakeChatCompletionsModel;
  resolveServerEnvironment(directories: IntegrationDirectories): Record<string, string>;
  prepareWorkspace(directories: IntegrationDirectories): Promise<void>;
  afterGarconStop(directories: IntegrationDirectories): Promise<void>;
  extraDiagnostics(directories: IntegrationDirectories): Record<string, unknown>;
  dispose(): void;
}

export function startScriptedOpenCodeTestEnvironment(options: {
  autoCompact?: boolean;
  proxy?: boolean;
  platform?: NodeJS.Platform;
} = {}): ScriptedOpenCodeTestEnvironment {
  assertScriptedOpenCodePlatform(options.platform);
  const model = FakeChatCompletionsModel.start();
  const preparedRoots = new Set<string>();
  const cleanedRoots = new Set<string>();

  const resolveServerEnvironment = (directories: IntegrationDirectories) => {
    const paths = openCodePaths(directories);
    assertFixtureOwnedPaths(paths, directories.root);
    const environment: Record<string, string> = {
      HOME: directories.home,
      XDG_CONFIG_HOME: paths.xdgConfig,
      XDG_DATA_HOME: paths.xdgData,
      XDG_STATE_HOME: paths.xdgState,
      XDG_CACHE_HOME: paths.xdgCache,
      TMPDIR: paths.temp,
      OPENCODE_TEST_HOME: directories.home,
      OPENCODE_DB: paths.database,
      OPENCODE_CONFIG: paths.config,
      OPENCODE_TEST_MANAGED_CONFIG_DIR: paths.managedConfig,
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_PURE: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1',
      OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
      OPENCODE_DISABLE_EMBEDDED_WEB_UI: '1',
      OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: '1',
      OPENCODE_DISABLE_SHARE: '1',
      npm_config_registry: `${model.baseUrl}/npm/`,
      npm_config_cache: paths.npmCache,
      GARCON_TEST_OPENCODE_REAL_BINARY: OPENCODE_BINARY,
      GARCON_TEST_OPENCODE_VERIFICATION: paths.verification,
      GARCON_TEST_OPENCODE_PROCESS_STATE: paths.processState,
      PATH: [
        paths.bin,
        dirname(process.execPath),
        SYSTEM_PATH,
      ].join(':'),
    };
    if (!options.autoCompact) {
      environment.OPENCODE_DISABLE_AUTOCOMPACT = '1';
    }
    if (options.proxy) {
      environment.GARCON_TEST_OPENCODE_PROXY_DIR = paths.proxy;
    }
    return environment;
  };

  return {
    model,
    resolveServerEnvironment,
    async prepareWorkspace(directories) {
      preparedRoots.add(directories.root);
      const paths = openCodePaths(directories);
      assertFixtureOwnedPaths(paths, directories.root);
      for (const directory of [
        paths.bin,
        paths.processState,
        paths.proxy,
        paths.xdgConfig,
        paths.globalConfig,
        paths.xdgData,
        paths.xdgState,
        paths.xdgCache,
        paths.npmCache,
        paths.managedConfig,
        paths.temp,
      ]) {
        await mkdir(directory, { recursive: true });
      }
      await writeFile(paths.config, JSON.stringify(openCodeConfig(model.baseUrl), null, 2), {
        mode: 0o600,
      });
      await writeOpenCodePluginSeed(paths.globalConfig);
      const shim = join(paths.bin, 'opencode');
      await writeFile(shim, [
        '#!/bin/sh',
        `exec ${shellQuote(process.execPath)} ${shellQuote(SUPERVISOR_MODULE)} "$@"`,
        '',
      ].join('\n'), { mode: 0o755 });
      await chmod(shim, 0o755);
      const version = await verifyPinnedBinaryVersion({
        binary: OPENCODE_BINARY,
        env: buildOpenCodeProviderEnvironment(resolveServerEnvironment(directories)),
      });
      await writeJsonAtomic(paths.verification, {
        binary: OPENCODE_BINARY,
        version,
      } satisfies OpenCodeBinaryVerification);
    },
    async afterGarconStop(directories) {
      const records = await readSupervisorStateRecords(directories);
      const failures: string[] = [];
      const deadline = Date.now() + 5_000;
      const identities = records.flatMap(({ state }) => processIdentities(state));
      while (Date.now() < deadline && identities.some(identityAlive)) {
        await Bun.sleep(20);
      }
      for (const record of records) {
        const survivors = processIdentities(record.state).filter(identityAlive);
        if (survivors.length === 0) continue;

        // Re-reading immediately before signaling prevents an old state snapshot from acting
        // on a later wrapper generation that reused the same state-file PID.
        const latest = await readJsonFile<OpenCodeProcessState>(record.path);
        if (
          !latest
          || latest.generationId !== record.state.generationId
          || latest.status === 'stopped'
        ) {
          failures.push(
            `OpenCode generation ${record.state.generationId} survived without a signal-safe running record`,
          );
          continue;
        }
        const signalable = processIdentities(latest).filter(identityAlive);
        for (const identity of signalable) {
          try {
            // The final identity check narrows the unavoidable /proc-to-kill interval and
            // refuses any PID whose Linux start time no longer matches the test record.
            if (identityAlive(identity)) process.kill(identity.pid, 'SIGKILL');
          } catch {
            // Already gone between the check and the signal.
          }
        }
        const signalDeadline = Date.now() + 1_000;
        while (Date.now() < signalDeadline && signalable.some(identityAlive)) {
          await Bun.sleep(10);
        }
        const remaining = signalable.filter(identityAlive).map(({ pid }) => pid);
        failures.push(
          `OpenCode wrapper ${latest.wrapperPid} (provider ${latest.providerPid}, mode ${latest.mode})`
          + ` survived Garcon stop; signaled identities ${signalable.map(({ pid }) => pid).join(', ')}`,
          ...remaining.map((pid) => `OpenCode identity ${pid} survived its cleanup SIGKILL`),
        );
      }
      if (failures.length > 0) {
        throw new Error(`OpenCode process cleanup failed:\n${failures.join('\n')}`);
      }
      cleanedRoots.add(directories.root);
    },
    extraDiagnostics(directories) {
      const paths = openCodePaths(directories);
      return {
        opencode: {
          version: OPENCODE_VERSION,
          configPath: paths.config,
          databasePath: paths.database,
          mode: options.proxy ? 'proxy' : 'direct',
          supervisors: readSupervisorStatesSync(paths.processState),
          modelRequests: model.requests().map((request) => ({
            id: request.id,
            userTexts: request.userTexts,
            toolResults: request.toolResults,
          })),
          protocolViolations: model.protocolViolations(),
          otherRequests: model.otherRequests(),
        },
      };
    },
    dispose() {
      const problems: string[] = [];
      try {
        model.assertSettled();
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
      }
      try {
        if (model.otherRequests().length > 0) {
          problems.push(
            `Fake model received unexpected routes (npm trap or auxiliary traffic):\n${
              model.otherRequests().join('\n')
            }`,
          );
        }
        for (const root of preparedRoots) {
          if (!cleanedRoots.has(root)) {
            problems.push(`OpenCode process cleanup hook never completed for ${root}`);
          }
        }
      } finally {
        model.stop();
      }
      if (problems.length > 0) {
        throw new AggregateError(problems, 'Scripted OpenCode environment was not settled.');
      }
    },
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function writeOpenCodePluginSeed(globalConfigDir: string): Promise<void> {
  await mkdir(join(globalConfigDir, 'node_modules'), { recursive: true });
  for (const [name, contents] of Object.entries(OPENCODE_PLUGIN_SEED_FILES)) {
    await writeFile(join(globalConfigDir, name), contents);
  }
}

export async function readSupervisorStates(
  directories: IntegrationDirectories,
): Promise<OpenCodeProcessState[]> {
  return (await readSupervisorStateRecords(directories)).map(({ state }) => state);
}

interface OpenCodeSupervisorStateRecord {
  path: string;
  state: OpenCodeProcessState;
}

interface OpenCodeProcessIdentity {
  pid: number;
  startTimeTicks: string;
}

function processIdentities(state: OpenCodeProcessState): OpenCodeProcessIdentity[] {
  const identities: OpenCodeProcessIdentity[] = [{
    pid: state.wrapperPid,
    startTimeTicks: state.wrapperStartTimeTicks,
  }];
  if (state.providerPid > 0 && state.providerStartTimeTicks) {
    identities.push({
      pid: state.providerPid,
      startTimeTicks: state.providerStartTimeTicks,
    });
  }
  return identities;
}

function identityAlive(identity: OpenCodeProcessIdentity): boolean {
  return processIdentityAlive(identity.pid, identity.startTimeTicks);
}

async function readSupervisorStateRecords(
  directories: IntegrationDirectories,
): Promise<OpenCodeSupervisorStateRecord[]> {
  const processStateDir = openCodePaths(directories).processState;
  let entries: string[];
  try {
    entries = readdirSync(processStateDir);
  } catch {
    return [];
  }
  const records: OpenCodeSupervisorStateRecord[] = [];
  for (const entry of entries) {
    if (!entry.startsWith('wrapper-') || !entry.endsWith('.json') || entry.includes('.tmp-')) {
      continue;
    }
    const path = join(processStateDir, entry);
    const state = await readJsonFile<OpenCodeProcessState>(path);
    if (state) records.push({ path, state });
  }
  return records;
}

function readSupervisorStatesSync(processStateDir: string): OpenCodeProcessState[] {
  let entries: string[];
  try {
    entries = readdirSync(processStateDir);
  } catch {
    return [];
  }
  const states: OpenCodeProcessState[] = [];
  for (const entry of entries) {
    if (!entry.startsWith('wrapper-') || !entry.endsWith('.json') || entry.includes('.tmp-')) {
      continue;
    }
    try {
      states.push(JSON.parse(readFileSync(join(processStateDir, entry), 'utf8')));
    } catch {
      // A state file being renamed mid-read is skipped; diagnostics are best effort.
    }
  }
  return states;
}

// Waits until the exact test-recorded wrapper and provider identities are gone so a crash
// replacement cannot share the fixture DB with its predecessor.
export async function waitForSupervisorExit(
  states: readonly OpenCodeProcessState[],
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const identities = states.flatMap(processIdentities);
  while (Date.now() < deadline) {
    if (identities.every((identity) => !identityAlive(identity))) return;
    await Bun.sleep(20);
  }
  const survivors = identities.filter(identityAlive).map(({ pid }) => pid);
  throw new Error(
    `OpenCode supervisor identities still alive after Garcon crash: ${survivors.join(', ')}`,
  );
}

export function scriptedOpenCodeStartRequest(input: {
  chatId: string;
  projectPath: string;
  command: string;
  permissionMode?: StartChatCommandRequest['permissionMode'];
}): StartChatCommandRequest {
  return {
    clientRequestId: crypto.randomUUID(),
    clientMessageId: crypto.randomUUID(),
    chatId: input.chatId,
    agentId: 'opencode',
    projectPath: input.projectPath,
    model: OPENCODE_TEST_MODEL,
    permissionMode: input.permissionMode ?? 'bypassPermissions',
    thinkingMode: OPENCODE_TEST_THINKING_MODE,
    agentSettings: OPENCODE_AGENT_SETTINGS,
    command: input.command,
  };
}

export function scriptedOpenCodeRunRequest(input: {
  chatId: string;
  command: string;
  permissionMode?: AgentRunCommandRequest['permissionMode'];
}): AgentRunCommandRequest {
  return {
    clientRequestId: crypto.randomUUID(),
    clientMessageId: crypto.randomUUID(),
    chatId: input.chatId,
    command: input.command,
    permissionMode: input.permissionMode ?? 'bypassPermissions',
    thinkingMode: OPENCODE_TEST_THINKING_MODE,
    agentSettings: OPENCODE_AGENT_SETTINGS,
    model: OPENCODE_TEST_MODEL,
  };
}

export interface OpenCodeNativeSession {
  agentSessionId: string;
  artificialPath: string;
  databasePath: string;
}

export async function openCodeNativeSession(
  fixture: { readonly dirs: IntegrationDirectories },
  chatId: string,
): Promise<OpenCodeNativeSession> {
  const registry = JSON.parse(
    await readFile(join(fixture.dirs.workspace, 'chats.json'), 'utf8'),
  ) as { sessions?: Record<string, Record<string, unknown>> };
  const chat = registry.sessions?.[chatId];
  if (chat?.agentId !== 'opencode') throw new Error(`Chat ${chatId} is not an OpenCode chat.`);
  const agentSessionId = typeof chat.agentSessionId === 'string' ? chat.agentSessionId : '';
  const nativeSession = chat.nativeSession && typeof chat.nativeSession === 'object'
    ? chat.nativeSession as Record<string, unknown>
    : null;
  const value = nativeSession?.value && typeof nativeSession.value === 'object'
    ? nativeSession.value as Record<string, unknown>
    : null;
  const artificialPath = typeof value?.path === 'string' ? value.path : '';
  if (!agentSessionId || artificialPath !== `!opencode:${agentSessionId}`) {
    throw new Error(`Chat ${chatId} has an invalid OpenCode native identity.`);
  }
  return {
    agentSessionId,
    artificialPath,
    databasePath: openCodePaths(fixture.dirs).database,
  };
}

export interface OpenCodeSessionRows {
  messages: Array<{ id: string; time_created: number; data: Record<string, unknown> }>;
  parts: Array<{
    id: string;
    message_id: string;
    time_created: number;
    data: Record<string, unknown>;
  }>;
}

// Opens the fixture-owned native DB read-only; intentionally coupled to the pinned OpenCode
// schema because the native contract is the behavior under test.
export function readOpenCodeSessionRows(native: OpenCodeNativeSession): OpenCodeSessionRows {
  const database = new Database(native.databasePath, { readonly: true, strict: true });
  try {
    const messages = database.query(`
      SELECT id, data, time_created
      FROM message
      WHERE session_id = ?
      ORDER BY time_created, id
    `).all(native.agentSessionId) as Array<{
      id: string;
      data: string;
      time_created: number;
    }>;
    const parts = database.query(`
      SELECT id, message_id, data, time_created
      FROM part
      WHERE session_id = ?
      ORDER BY time_created, id
    `).all(native.agentSessionId) as Array<{
      id: string;
      message_id: string;
      data: string;
      time_created: number;
    }>;
    return {
      messages: messages.map((row) => ({
        id: row.id,
        time_created: row.time_created,
        data: JSON.parse(row.data) as Record<string, unknown>,
      })),
      parts: parts.map((row) => ({
        id: row.id,
        message_id: row.message_id,
        time_created: row.time_created,
        data: JSON.parse(row.data) as Record<string, unknown>,
      })),
    };
  } finally {
    database.close();
  }
}

export function readOpenCodeSessionCount(databasePath: string): number {
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    const row = database.query('SELECT COUNT(*) AS count FROM session').get() as {
      count: number;
    } | null;
    return row?.count ?? 0;
  } finally {
    database.close();
  }
}
