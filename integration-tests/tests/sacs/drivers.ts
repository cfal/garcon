import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  chatCompletionsText,
  chatCompletionsToolUse,
} from '../../support/fake-chat-completions-model.js';
import { claudeText } from '../../support/fake-claude-model.js';
import { codexAssistantMessage } from '../../support/fake-codex-model.js';
import { liveClaudeRunRequest, liveClaudeStartRequest } from '../../support/live-claude.js';
import { liveCodexRunRequest, liveCodexStartRequest } from '../../support/live-codex.js';
import { startScriptedClaudeTestEnvironment } from '../../support/scripted-claude.js';
import { startScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';
import {
  openCodePaths,
  scriptedOpenCodeRunRequest,
  scriptedOpenCodeStartRequest,
  startScriptedOpenCodeTestEnvironment,
} from '../../support/scripted-opencode.js';
import {
  scriptedPiRunRequest,
  scriptedPiStartRequest,
  startScriptedPiTestEnvironment,
} from '../../support/scripted-pi.js';
import {
  waitForPersistedChat,
  waitForPersistedNativeSession,
} from '../../support/persisted-chat.js';
import type {
  IntegrationFixture,
} from '../../support/integration-fixture.js';
import type {
  SacsDriverEnvironment,
  SacsDriverFactory,
  SacsHeldTurn,
  SacsLegacyHistoryImportFacet,
  SacsLegacyTranscriptRow,
  SacsNativeForkingFacet,
  SacsNativeHistoryImportFacet,
  SacsPreparedHistorySource,
} from './driver.js';

const STEERING = { kind: 'steering' } as const;
const NATIVE_SESSIONS = { kind: 'native-sessions' } as const;

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function replaceableFile(
  path: string,
  emptyContents: (original: Uint8Array) => string = () => '',
  corruptContents?: (original: Uint8Array) => string,
): SacsPreparedHistorySource {
  let original: Uint8Array | null = null;
  const capture = async () => {
    original ??= await readFile(path);
    return original;
  };
  return {
    async corrupt() {
      const captured = await capture();
      await rm(path, { recursive: true, force: true });
      if (corruptContents) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, corruptContents(captured), 'utf8');
      } else {
        await mkdir(path, { recursive: true });
      }
    },
    async empty() {
      const captured = await capture();
      await rm(path, { recursive: true, force: true });
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, emptyContents(captured), 'utf8');
    },
    async restore() {
      if (!original) throw new Error(`SACS history source ${path} was not captured before restore.`);
      await rm(path, { recursive: true, force: true });
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, original);
    },
    async remove() {
      await rm(path, { recursive: true, force: true });
    },
  };
}

type SacsHistorySourcePreparer = (
  fixture: IntegrationFixture,
  chatId: string,
) => Promise<SacsPreparedHistorySource>;

async function resolvePersistedNativePath(
  fixture: IntegrationFixture,
  chatId: string,
  agentId: string,
): Promise<string> {
  const binding = await waitForPersistedNativeSession({
    directories: fixture.dirs,
    chatId,
    agentId,
  });
  const nativeSession = binding.nativeSession && typeof binding.nativeSession === 'object'
    ? binding.nativeSession as Record<string, unknown>
    : null;
  const value = nativeSession?.value && typeof nativeSession.value === 'object'
    ? nativeSession.value as Record<string, unknown>
    : null;
  const path = typeof value?.path === 'string' ? value.path : '';
  if (!path) {
    throw new Error(`SACS chat ${chatId} has no readable path-backed history source.`);
  }
  const deadline = Date.now() + 5_000;
  while (!await fileExists(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`SACS chat ${chatId} did not materialize its path-backed history source.`);
    }
    await Bun.sleep(20);
  }
  return path;
}

function filesystemHistorySource(
  agentId: string,
  emptyContents: (original: Uint8Array) => string = () => '',
  corruptContents?: (original: Uint8Array) => string,
): SacsHistorySourcePreparer {
  return async (fixture, chatId) => {
    const path = await resolvePersistedNativePath(fixture, chatId, agentId);
    return replaceableFile(path, emptyContents, corruptContents);
  };
}

// Dropping every native line containing the marker removes the identities the
// integration would resolve a fork boundary from, without disturbing the rest
// of the session record.
function pathBackedForkingFacet(agentId: string): SacsNativeForkingFacet {
  return {
    kind: 'native-forking',
    async unsettle(fixture, chatId, marker) {
      const path = await resolvePersistedNativePath(fixture, chatId, agentId);
      const original = await readFile(path, 'utf8');
      const retained = original
        .split('\n')
        .filter((line) => !line.includes(marker));
      await writeFile(path, retained.join('\n'));
    },
  };
}

const openCodeForkingFacet: SacsNativeForkingFacet = {
  kind: 'native-forking',
  async unsettle(fixture, chatId, marker) {
    const binding = await waitForPersistedChat({
      directories: fixture.dirs,
      chatId,
      select: (candidate) => (candidate.agentSessionId ? candidate : null),
      timeoutMessage: `SACS chat ${chatId} did not persist the required binding.`,
    });
    const sessionId = binding.agentSessionId;
    if (!sessionId) throw new Error(`SACS OpenCode chat ${chatId} has no persisted session.`);
    const database = new Database(openCodePaths(fixture.dirs).database, { strict: true });
    try {
      const markerPattern = `%${marker}%`;
      const messageIds = new Set<string>([
        ...(database.query(
          'SELECT DISTINCT message_id AS id FROM part WHERE session_id = ? AND data LIKE ?',
        ).all(sessionId, markerPattern) as Array<{ id: string }>).map((row) => row.id),
        ...(database.query(
          'SELECT id FROM message WHERE session_id = ? AND data LIKE ?',
        ).all(sessionId, markerPattern) as Array<{ id: string }>).map((row) => row.id),
      ]);
      if (messageIds.size === 0) {
        throw new Error(`SACS OpenCode session ${sessionId} has no messages containing the marker.`);
      }
      database.transaction(() => {
        for (const messageId of messageIds) {
          database.query('DELETE FROM part WHERE message_id = ?').run(messageId);
          database.query('DELETE FROM message WHERE id = ?').run(messageId);
        }
      })();
    } finally {
      database.close();
    }
  },
};

function legacyHistoryImport(
  prepare: SacsHistorySourcePreparer,
): SacsLegacyHistoryImportFacet {
  return {
    kind: 'legacy-history-import',
    directoryScoped: null,
    prepare: (fixture, chatId) => prepare(fixture, chatId),
  };
}

function nativeHistoryImport(
  prepare: SacsHistorySourcePreparer,
): SacsNativeHistoryImportFacet {
  return {
    kind: 'native-history-import',
    prepare: (fixture, chatId) => prepare(fixture, chatId),
  };
}

function retainJsonlRecords(original: Uint8Array, type: string): string {
  const retained = Buffer.from(original).toString('utf8').split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    const parsed = JSON.parse(line) as { type?: unknown };
    return parsed.type === type ? [line] : [];
  });
  return retained.length > 0 ? `${retained.join('\n')}\n` : '';
}

async function prepareOpenCodeHistorySource(
  fixture: IntegrationFixture,
  chatId: string,
): Promise<SacsPreparedHistorySource> {
  const path = openCodePaths(fixture.dirs).database;
  if (!await fileExists(path)) throw new Error('SACS OpenCode database was not created.');
  const binding = await waitForPersistedChat({
    directories: fixture.dirs,
    chatId,
    select: (candidate) => candidate.agentSessionId ? candidate : null,
    timeoutMessage: `SACS chat ${chatId} did not persist the required binding.`,
  });
  const sessionId = binding.agentSessionId;
  if (!sessionId) throw new Error(`SACS OpenCode chat ${chatId} has no persisted session.`);
  let originalMessage: { readonly id: string; readonly data: string } | null = null;
  let removedTables:
    | readonly { readonly table: string; readonly rows: readonly OpenCodeStoredRow[] }[]
    | null = null;
  return {
    async corrupt() {
      const database = new Database(path, { strict: true });
      try {
        originalMessage = database.query(`
          SELECT id, data FROM message WHERE session_id = ? ORDER BY id LIMIT 1
        `).get(sessionId) as { id: string; data: string } | null;
        if (!originalMessage) {
          throw new Error(`SACS OpenCode session ${sessionId} has no messages to corrupt.`);
        }
        database.query('UPDATE message SET data = ? WHERE id = ?')
          .run('{}', originalMessage.id);
      } finally {
        database.close();
      }
    },
    async empty() {
      const database = new Database(path, { strict: true });
      try {
        database.transaction(() => {
          database.query('DELETE FROM part WHERE session_id = ?').run(sessionId);
          database.query('DELETE FROM message WHERE session_id = ?').run(sessionId);
        })();
      } finally {
        database.close();
      }
    },
    async restore() {
      if (removedTables) {
        const restoredTables = removedTables;
        const database = new Database(path, { strict: true });
        try {
          database.transaction(() => {
            for (const { table, rows } of restoredTables) {
              for (const row of rows) {
                const columns = Object.keys(row);
                database.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${
                  columns.map(() => '?').join(', ')
                })`).run(...Object.values(row));
              }
            }
          })();
        } finally {
          database.close();
        }
        removedTables = null;
        return;
      }
      if (!originalMessage) {
        throw new Error(`SACS OpenCode session ${sessionId} was not captured before restore.`);
      }
      const database = new Database(path, { strict: true });
      try {
        database.query('UPDATE message SET data = ? WHERE id = ?')
          .run(originalMessage.data, originalMessage.id);
      } finally {
        database.close();
      }
    },
    async remove() {
      const database = new Database(path, { strict: true });
      try {
        removedTables = [
          { table: 'session', column: 'id' },
          { table: 'message', column: 'session_id' },
          { table: 'part', column: 'session_id' },
        ].map(({ table, column }) => ({
          table,
          rows: database.query(`SELECT * FROM ${table} WHERE ${column} = ?`)
            .all(sessionId) as OpenCodeStoredRow[],
        }));
        database.transaction(() => {
          database.query('DELETE FROM part WHERE session_id = ?').run(sessionId);
          database.query('DELETE FROM message WHERE session_id = ?').run(sessionId);
          database.query('DELETE FROM session WHERE id = ?').run(sessionId);
        })();
      } finally {
        database.close();
      }
    },
  };
}

type OpenCodeStoredRow = Record<string, string | number | bigint | null | Uint8Array>;

const openCodeLegacyHistoryImport: SacsLegacyHistoryImportFacet = {
  kind: 'legacy-history-import',
  directoryScoped: {
    async moveBindingToDifferentDirectory(fixture, chatId) {
      const registryPath = join(fixture.dirs.workspace, 'chats.json');
      const rebindProjectPath = async (
        update: (chat: Record<string, unknown>) => void,
      ) => {
        const registry = JSON.parse(await readFile(registryPath, 'utf8')) as {
          sessions?: Record<string, Record<string, unknown>>;
        };
        const chat = registry.sessions?.[chatId];
        if (!chat) throw new Error(`SACS chat ${chatId} is missing from the registry.`);
        update(chat);
        await writeFile(registryPath, JSON.stringify(registry));
        return chat;
      };
      const projectPath = join(fixture.dirs.root, 'opencode-other-project');
      await mkdir(projectPath, { recursive: true });
      let originalProjectPath: unknown;
      await rebindProjectPath((chat) => {
        originalProjectPath = chat.projectPath;
        chat.projectPath = projectPath;
      });
      return {
        async restore() {
          await rebindProjectPath((chat) => {
            chat.projectPath = originalProjectPath;
          });
        },
      };
    },
  },
  prepare: prepareOpenCodeHistorySource,
};

const openCodeNativeHistoryImport = nativeHistoryImport(prepareOpenCodeHistorySource);

function directHistorySource(agentId: string): SacsHistorySourcePreparer {
  return async (fixture, chatId) => {
    const binding = await waitForPersistedNativeSession({
      directories: fixture.dirs,
      chatId,
      agentId,
    });
    if (!binding.agentSessionId) {
      throw new Error(`SACS Direct chat ${chatId} has no persisted session.`);
    }
    const path = join(
      fixture.dirs.workspace,
      'agent-data',
      agentId,
      'direct-sessions-v1',
      `${binding.agentSessionId}.jsonl`,
    );
    const deadline = Date.now() + 5_000;
    while (!await fileExists(path)) {
      if (Date.now() >= deadline) {
        throw new Error(`SACS Direct chat ${chatId} did not persist its native history.`);
      }
      await Bun.sleep(20);
    }
    return replaceableFile(path);
  };
}

function heldTurn(held: { readonly requested: Promise<unknown>; release(): void }): SacsHeldTurn {
  return {
    requested: held.requested,
    allowCancellation: () => {},
    release: () => held.release(),
  };
}

const claudeHistorySource = filesystemHistorySource('claude');
const codexHistorySource = filesystemHistorySource('codex', (original) => (
  retainJsonlRecords(original, 'session_meta')
));
const piHistorySource = filesystemHistorySource('pi', (original) => (
  retainJsonlRecords(original, 'session')
), (original) => (
  `${retainJsonlRecords(original, 'session')}${[
    {
      type: 'message',
      id: 'sacs-cycle-a',
      parentId: 'sacs-cycle-b',
      message: { role: 'user', content: 'cycle a', timestamp: 1 },
    },
    {
      type: 'message',
      id: 'sacs-cycle-b',
      parentId: 'sacs-cycle-a',
      message: { role: 'user', content: 'cycle b', timestamp: 2 },
    },
  ].map((entry) => JSON.stringify(entry)).join('\n')}\n`
));

const claudeDriver: SacsDriverFactory = {
  id: 'claude',
  label: 'Claude',
  steering: STEERING,
  nativeSessions: NATIVE_SESSIONS,
  nativeHistoryImport: nativeHistoryImport(claudeHistorySource),
  legacyHistoryImport: legacyHistoryImport(claudeHistorySource),
  forking: pathBackedForkingFacet('claude'),
  async start() {
    const environment = await startScriptedClaudeTestEnvironment();
    return {
      id: 'claude',
      label: 'Claude',
      fixtureOptions: { serverEnvironment: environment.serverEnvironment },
      startRequest: (_fixture, input) => liveClaudeStartRequest(input),
      runRequest: (_fixture, input) => liveClaudeRunRequest(input),
      holdAssistant: (_fixture, content) => heldTurn(
        environment.model.scriptHeldTurn([claudeText(content)]),
      ),
      holdInterruptibleAssistant: (_fixture, content) => heldTurn(
        environment.model.scriptHeldTurn([claudeText(content)]),
      ),
      scriptAssistant: (_fixture, content) => environment.model.scriptTurn([claudeText(content)]),
      markRequests: () => environment.model.markRequests(),
      requestCountSince: (_fixture, cursor) => environment.model.requestsSince(cursor).length,
      userTextsSince: (_fixture, cursor) => environment.model.requestsSince(cursor)
        .flatMap((request) => request.userTexts),
      assertSettled: () => environment.model.assertSettled(),
      reset: () => environment.model.reset(),
      dispose: () => environment.dispose(),
    } satisfies SacsDriverEnvironment;
  },
};

const codexDriver: SacsDriverFactory = {
  id: 'codex',
  label: 'Codex',
  steering: STEERING,
  nativeSessions: NATIVE_SESSIONS,
  nativeHistoryImport: nativeHistoryImport(codexHistorySource),
  legacyHistoryImport: legacyHistoryImport(codexHistorySource),
  forking: pathBackedForkingFacet('codex'),
  async start() {
    const environment = await startScriptedCodexTestEnvironment();
    return {
      id: 'codex',
      label: 'Codex',
      fixtureOptions: {
        serverEnvironment: environment.serverEnvironment,
        prepareWorkspace: environment.prepareWorkspace,
      },
      startRequest: (_fixture, input) => liveCodexStartRequest(input),
      runRequest: (_fixture, input) => liveCodexRunRequest(input),
      holdAssistant: (_fixture, content) => heldTurn(environment.model.scriptHeldTurn([
        codexAssistantMessage(content),
      ])),
      holdInterruptibleAssistant: (_fixture, content) => heldTurn(
        environment.model.scriptHeldTurn([codexAssistantMessage(content)]),
      ),
      scriptAssistant: (_fixture, content) => environment.model.scriptTurn([
        codexAssistantMessage(content),
      ]),
      markRequests: () => environment.model.markRequests(),
      requestCountSince: (_fixture, cursor) => environment.model.requestsSince(cursor).length,
      userTextsSince: (_fixture, cursor) => environment.model.requestsSince(cursor)
        .flatMap((request) => request.userTexts),
      assertSettled: () => environment.model.assertSettled(),
      reset: () => environment.model.reset(),
      dispose: () => environment.dispose(),
    } satisfies SacsDriverEnvironment;
  },
};

const piDriver: SacsDriverFactory = {
  id: 'pi',
  label: 'Pi',
  steering: STEERING,
  nativeSessions: NATIVE_SESSIONS,
  nativeHistoryImport: nativeHistoryImport(piHistorySource),
  forking: null,
  legacyHistoryImport: legacyHistoryImport(piHistorySource),
  async start() {
    const environment = startScriptedPiTestEnvironment();
    return {
      id: 'pi',
      label: 'Pi',
      fixtureOptions: {
        serverEnvironment: environment.serverEnvironment,
        prepareWorkspace: environment.prepareWorkspace,
      },
      startRequest: (_fixture, input) => scriptedPiStartRequest(input),
      runRequest: (_fixture, input) => scriptedPiRunRequest(input),
      holdAssistant: (_fixture, content) => heldTurn(environment.model.scriptHeldTurn([
        chatCompletionsText(content),
      ])),
      holdInterruptibleAssistant: (_fixture, content) => {
        environment.model.scriptTurn([chatCompletionsToolUse(
          `sacs-pi-interrupt-${crypto.randomUUID()}`,
          'bash',
          { command: "printf 'sacs pi interrupt ready'" },
        )]);
        return heldTurn(environment.model.scriptHeldTurn([chatCompletionsText(content)]));
      },
      scriptAssistant: (_fixture, content) => environment.model.scriptTurn([
        chatCompletionsText(content),
      ]),
      markRequests: () => environment.model.markRequests(),
      requestCountSince: (_fixture, cursor) => environment.model.requestsSince(cursor).length,
      userTextsSince: (_fixture, cursor) => environment.model.requestsSince(cursor)
        .flatMap((request) => request.userTexts),
      assertSettled: () => environment.model.assertSettled(),
      reset: () => environment.model.reset(),
      dispose: () => environment.dispose(),
    } satisfies SacsDriverEnvironment;
  },
};

const openCodeDriver: SacsDriverFactory = {
  id: 'opencode',
  label: 'OpenCode',
  steering: STEERING,
  nativeSessions: NATIVE_SESSIONS,
  nativeHistoryImport: openCodeNativeHistoryImport,
  legacyHistoryImport: openCodeLegacyHistoryImport,
  forking: openCodeForkingFacet,
  async start() {
    const environment = startScriptedOpenCodeTestEnvironment();
    return {
      id: 'opencode',
      label: 'OpenCode',
      fixtureOptions: {
        resolveServerEnvironment: environment.resolveServerEnvironment,
        prepareWorkspace: environment.prepareWorkspace,
        afterGarconStop: environment.afterGarconStop,
        extraDiagnostics: environment.extraDiagnostics,
      },
      startRequest: (_fixture, input) => scriptedOpenCodeStartRequest(input),
      runRequest: (_fixture, input) => scriptedOpenCodeRunRequest(input),
      holdAssistant: (_fixture, content) => heldTurn(environment.model.scriptHeldTurn([
        chatCompletionsText(content),
      ])),
      holdInterruptibleAssistant: (_fixture, content) => heldTurn(
        environment.model.scriptHeldTurn([chatCompletionsText(content)]),
      ),
      scriptAssistant: (_fixture, content) => environment.model.scriptTurn([
        chatCompletionsText(content),
      ]),
      markRequests: () => environment.model.markRequests(),
      requestCountSince: (_fixture, cursor) => environment.model.requestsSince(cursor).length,
      userTextsSince: (_fixture, cursor) => environment.model.requestsSince(cursor)
        .flatMap((request) => request.userTexts),
      assertSettled: () => environment.model.assertSettled(),
      reset: () => environment.model.reset(),
      dispose: () => environment.dispose(),
    } satisfies SacsDriverEnvironment;
  },
};

interface DirectRequest {
  readonly id: number;
  readonly lastUserText: string;
}

interface DirectHeldRequest {
  readonly received: Promise<unknown>;
  expectAbort(): Promise<unknown>;
  releaseText(content: string): boolean;
}

interface DirectProviderHarness {
  holdNext(matcher: Record<string, never>): DirectHeldRequest;
  requests(): readonly DirectRequest[];
  assertNoProtocolViolations(): void;
}

function directDriver(
  id: string,
  label: string,
  selectAgent: (fixture: IntegrationFixture) => IntegrationFixture['directAgents']['openAi'],
  selectProvider: (fixture: IntegrationFixture) => DirectProviderHarness,
): SacsDriverFactory {
  return {
    id,
    label,
    steering: null,
    nativeSessions: NATIVE_SESSIONS,
    nativeHistoryImport: nativeHistoryImport(directHistorySource(id)),
    forking: null,
    legacyHistoryImport: null,
    async start() {
      const holdAssistant = (fixture: IntegrationFixture, content: string): SacsHeldTurn => {
        const held = selectProvider(fixture).holdNext({});
        return {
          requested: held.received,
          allowCancellation: () => {
            void held.expectAbort().catch(() => undefined);
          },
          release: () => {
            held.releaseText(content);
          },
        };
      };
      return {
        id,
        label,
        fixtureOptions: {},
        startRequest: (fixture, input) => fixture.client.directStartRequest({
          chatId: input.chatId,
          content: input.command,
          projectPath: input.projectPath,
          agent: selectAgent(fixture),
        }),
        runRequest: (fixture, input) => fixture.client.directRunRequest({
          chatId: input.chatId,
          content: input.command,
          agent: selectAgent(fixture),
        }),
        holdAssistant,
        holdInterruptibleAssistant: holdAssistant,
        scriptAssistant: (fixture, content) => {
          const held = selectProvider(fixture).holdNext({});
          held.releaseText(content);
        },
        markRequests: (fixture) => selectProvider(fixture).requests().at(-1)?.id ?? 0,
        requestCountSince: (fixture, cursor) => selectProvider(fixture).requests()
          .filter((request) => request.id > cursor).length,
        userTextsSince: (fixture, cursor) => selectProvider(fixture).requests()
          .filter((request) => request.id > cursor)
          .map((request) => request.lastUserText),
        assertSettled: (fixture) => selectProvider(fixture).assertNoProtocolViolations(),
        reset: () => {},
        dispose: () => {},
      } satisfies SacsDriverEnvironment;
    },
  };
}

const directOpenAiDriver = directDriver(
  'direct-openai-compatible',
  'Direct OpenAI Chat Completions',
  (fixture) => fixture.directAgents.openAi,
  (fixture) => fixture.fakeProviders.openAi,
);

const directOpenAiResponsesDriver = directDriver(
  'direct-openai-responses-compatible',
  'Direct OpenAI Responses',
  (fixture) => fixture.directAgents.openAiResponses,
  (fixture) => fixture.fakeProviders.openAiResponses,
);

const directAnthropicDriver = directDriver(
  'direct-anthropic-compatible',
  'Direct Anthropic',
  (fixture) => fixture.directAgents.anthropic,
  (fixture) => fixture.fakeProviders.anthropic,
);

export const sacsScriptedDriverFactories: readonly SacsDriverFactory[] = [
  claudeDriver,
  codexDriver,
  directOpenAiResponsesDriver,
  directOpenAiDriver,
  directAnthropicDriver,
  ...(process.platform === 'linux' ? [openCodeDriver] : []),
  piDriver,
];
