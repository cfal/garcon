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
  scriptedOpenCodeRunRequest,
  scriptedOpenCodeStartRequest,
  startScriptedOpenCodeTestEnvironment,
} from '../../support/scripted-opencode.js';
import {
  scriptedPiRunRequest,
  scriptedPiStartRequest,
  startScriptedPiTestEnvironment,
} from '../../support/scripted-pi.js';
import type {
  IntegrationFixture,
} from '../../support/integration-fixture.js';
import type {
  SacsDriverEnvironment,
  SacsDriverFactory,
  SacsHeldTurn,
} from './driver.js';

const STEERING = { kind: 'steering' } as const;
const NATIVE_SESSIONS = { kind: 'native-sessions' } as const;

function heldTurn(held: { readonly requested: Promise<unknown>; release(): void }): SacsHeldTurn {
  return {
    requested: held.requested,
    allowCancellation: () => {},
    release: () => held.release(),
  };
}

const claudeDriver: SacsDriverFactory = {
  id: 'claude',
  label: 'Claude',
  steering: STEERING,
  nativeSessions: NATIVE_SESSIONS,
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
    nativeSessions: null,
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

export const requiredSacsScriptedDriverIds = [
  'claude',
  'codex',
  'direct-openai-responses-compatible',
  'direct-openai-compatible',
  'direct-anthropic-compatible',
  ...(process.platform === 'linux' ? ['opencode'] : []),
  'pi',
] as const;
