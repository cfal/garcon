import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
import { waitForPersistedNativeSession } from '../../support/persisted-chat.js';
import type {
  IntegrationFixture,
} from '../../support/integration-fixture.js';
import type {
  SacsDriverEnvironment,
  SacsDriverFactory,
  SacsHeldTurn,
  SacsLegacyHistoryImportFacet,
  SacsLegacyTranscriptRow,
  SacsNativeHistoryImportFacet,
  SacsPreparedHistorySource,
  SacsReleasedJsonlFacet,
} from './driver.js';

const STEERING = { kind: 'steering' } as const;
const NATIVE_SESSIONS = { kind: 'native-sessions' } as const;

interface PersistedChatBinding {
  readonly agentSessionId: string | null;
  readonly modelEndpointId: string | null;
  readonly nativeSession: {
    readonly value?: Record<string, unknown>;
  } | null;
}

async function waitForPersistedChatBinding(
  fixture: IntegrationFixture,
  chatId: string,
  isReady: (binding: PersistedChatBinding) => boolean,
): Promise<PersistedChatBinding> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const registry = JSON.parse(
        await readFile(join(fixture.dirs.workspace, 'chats.json'), 'utf8'),
      ) as { sessions?: Record<string, PersistedChatBinding> };
      const binding = registry.sessions?.[chatId];
      if (binding && isReady(binding)) return binding;
    } catch {
      // The registry may be between asynchronous persistence attempts.
    }
    await Bun.sleep(20);
  }
  throw new Error(`SACS chat ${chatId} did not persist the required binding.`);
}

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

function filesystemHistorySource(
  agentId: string,
  emptyContents: (original: Uint8Array) => string = () => '',
  corruptContents?: (original: Uint8Array) => string,
): SacsHistorySourcePreparer {
  return async (fixture, chatId) => {
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
    return replaceableFile(path, emptyContents, corruptContents);
  };
}

function legacyHistoryImport(
  prepare: SacsHistorySourcePreparer,
): SacsLegacyHistoryImportFacet {
  return {
    kind: 'legacy-history-import',
    releasedJsonl: null,
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
  const binding = await waitForPersistedChatBinding(
    fixture,
    chatId,
    (candidate) => Boolean(candidate.agentSessionId),
  );
  const sessionId = binding.agentSessionId;
  if (!sessionId) throw new Error(`SACS OpenCode chat ${chatId} has no persisted session.`);
  let originalMessage: { readonly id: string; readonly data: string } | null = null;
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

const openCodeLegacyHistoryImport: SacsLegacyHistoryImportFacet = {
  kind: 'legacy-history-import',
  releasedJsonl: null,
  directoryScoped: {
    async moveBindingToDifferentDirectory(fixture, chatId) {
      const registryPath = join(fixture.dirs.workspace, 'chats.json');
      const registry = JSON.parse(await readFile(registryPath, 'utf8')) as {
        sessions?: Record<string, Record<string, unknown>>;
      };
      const chat = registry.sessions?.[chatId];
      if (!chat) throw new Error(`SACS chat ${chatId} is missing from the registry.`);
      const projectPath = join(fixture.dirs.root, 'opencode-other-project');
      await mkdir(projectPath, { recursive: true });
      chat.projectPath = projectPath;
      await writeFile(registryPath, JSON.stringify(registry));
    },
  },
  prepare: prepareOpenCodeHistorySource,
};

const openCodeNativeHistoryImport = nativeHistoryImport(prepareOpenCodeHistorySource);

function directLegacyHistoryImport(input: {
  readonly agentId: string;
  readonly directory: string;
  readonly context: SacsReleasedJsonlFacet['latestRequestContext'];
}): SacsLegacyHistoryImportFacet {
  const paths = async (fixture: IntegrationFixture, chatId: string) => {
    const binding = await waitForPersistedChatBinding(
      fixture,
      chatId,
      (candidate) => Boolean(candidate.agentSessionId && candidate.modelEndpointId),
    );
    if (!binding.agentSessionId || !binding.modelEndpointId) {
      throw new Error(`SACS Direct chat ${chatId} has no persisted session or endpoint.`);
    }
    const relativePath = join(
      input.directory,
      binding.modelEndpointId,
      `${binding.agentSessionId}.jsonl`,
    );
    return {
      legacyPath: join(fixture.dirs.workspace, relativePath),
      relocatedPath: join(
        fixture.dirs.workspace,
        'agent-data',
        input.agentId,
        relativePath,
      ),
    };
  };
  return {
    kind: 'legacy-history-import',
    releasedJsonl: {
      latestRequestContext: input.context,
      async snapshotRelocatedSource(fixture, chatId) {
        const { legacyPath, relocatedPath } = await paths(fixture, chatId);
        if (await fileExists(legacyPath)) {
          throw new Error(`SACS Direct legacy source was not relocated from ${legacyPath}.`);
        }
        const metadata = await stat(relocatedPath);
        return {
          path: relocatedPath,
          contents: await readFile(relocatedPath, 'utf8'),
          size: metadata.size,
          modifiedAtMs: metadata.mtimeMs,
        };
      },
    },
    directoryScoped: null,
    async prepare(fixture, chatId, rows) {
      const { legacyPath, relocatedPath } = await paths(fixture, chatId);
      const contents = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
      await rm(
        join(fixture.dirs.workspace, 'agent-data', input.agentId, 'migration-state.json'),
        { force: true },
      );
      await rm(relocatedPath, { recursive: true, force: true });
      await mkdir(dirname(legacyPath), { recursive: true });
      await writeFile(legacyPath, contents, 'utf8');

      return {
        async corrupt() {
          await writeFile(legacyPath, '{"role":"user","content":', 'utf8');
        },
        async empty() {
          await writeFile(legacyPath, '', 'utf8');
        },
        async restore() {
          const target = await fileExists(relocatedPath) ? relocatedPath : legacyPath;
          const other = target === legacyPath ? relocatedPath : legacyPath;
          await rm(other, { recursive: true, force: true });
          await rm(target, { recursive: true, force: true });
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, contents, 'utf8');
        },
        async remove() {
          await Promise.all([
            rm(legacyPath, { recursive: true, force: true }),
            rm(relocatedPath, { recursive: true, force: true }),
          ]);
        },
      };
    },
  };
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((part) => (
    part !== null
    && typeof part === 'object'
    && 'text' in part
    && typeof part.text === 'string'
      ? [part.text]
      : []
  )).join('\n');
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
  legacyHistoryImport: SacsLegacyHistoryImportFacet,
): SacsDriverFactory {
  return {
    id,
    label,
    steering: null,
    nativeSessions: null,
    nativeHistoryImport: null,
    legacyHistoryImport,
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
  directLegacyHistoryImport({
    agentId: 'direct-openai-compatible',
    directory: 'openai-compatible-sessions',
    context: (fixture) => fixture.fakeProviders.openAi.requests().at(-1)?.body.messages
      .map((message) => contentText(message.content)) ?? [],
  }),
);

const directOpenAiResponsesDriver = directDriver(
  'direct-openai-responses-compatible',
  'Direct OpenAI Responses',
  (fixture) => fixture.directAgents.openAiResponses,
  (fixture) => fixture.fakeProviders.openAiResponses,
  directLegacyHistoryImport({
    agentId: 'direct-openai-responses-compatible',
    directory: 'openai-compatible-responses-sessions',
    context: (fixture) => fixture.fakeProviders.openAiResponses.requests().at(-1)?.body.input
      .map((message) => contentText(message.content)) ?? [],
  }),
);

const directAnthropicDriver = directDriver(
  'direct-anthropic-compatible',
  'Direct Anthropic',
  (fixture) => fixture.directAgents.anthropic,
  (fixture) => fixture.fakeProviders.anthropic,
  directLegacyHistoryImport({
    agentId: 'direct-anthropic-compatible',
    directory: 'anthropic-compatible-sessions',
    context: (fixture) => fixture.fakeProviders.anthropic.requests().at(-1)?.body.messages
      .map((message) => contentText(message.content)) ?? [],
  }),
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
