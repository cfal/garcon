import type { ApiProviderCatalogEntry } from '../../common/api-providers.js';
import type { AgentStartOutcomeNoticeDetail } from '../../common/garcon-agent-result.js';
import type { ChatMessagesMessage } from '../../common/ws-events.js';
import { messagesOfType } from './chat-assertions.js';
import type { IntegrationFixture } from './integration-fixture.js';
import { INTEGRATION_OPENAI_API_KEY } from './openai-test-contract.js';

export const COMPACTION_MODEL = 'synthetic-startup-summary';
export const CHILD_TASK = 'Perform the synthetic delegated task.';

export async function prepareDelegatedHistory(fixture: IntegrationFixture): Promise<string> {
  const agent = fixture.directAgents.openAi;
  const chatId = fixture.newChatId();
  for (let index = 0; index < 9; index++) {
    const input = { chatId, content: `Synthetic history ${index}: ${'界'.repeat(8_000)}`, agent };
    const accepted = index === 0
      ? await fixture.client.startDirectChat({ ...input, projectPath: fixture.dirs.project })
      : await fixture.client.runDirectChat(input);
    await fixture.client.waitForTurnTerminal(chatId, accepted.turnId);
  }
  const provider = await fixture.client.post<ApiProviderCatalogEntry>('/api/v1/api-providers', {
    templateId: 'custom', label: 'Synthetic startup compaction', endpoint: {
      protocol: 'openai-compatible', baseUrl: `${fixture.fakeProviders.openAi.baseUrl}/v1`,
      apiKey: INTEGRATION_OPENAI_API_KEY, capabilities: { chatCompletions: true, responses: false },
      defaultModel: COMPACTION_MODEL, models: [{ value: COMPACTION_MODEL, label: 'Synthetic summary' }],
      supportsImages: false, modelDiscovery: 'none',
    },
  });
  await fixture.client.updateSettings({ ui: { agentSwitchCompaction: {
    enabled: true, contextWindowTokens: 200_000, agentId: agent.agentId, model: COMPACTION_MODEL,
    apiProviderId: provider.id, modelEndpointId: provider.endpoints[0]!.id,
    modelProtocol: 'openai-compatible', thinkingMode: 'none',
  } } });
  return chatId;
}

export async function requestSnapshotChild(fixture: IntegrationFixture, parent: string) {
  const prompt = 'Start the synthetic investigation.';
  const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: prompt });
  const cursor = fixture.client.markEvents();
  const accepted = await fixture.client.runDirectChat({ chatId: parent, content: prompt, agent: fixture.directAgents.openAi });
  await held.received;
  held.releaseText(`<garcon-start-agent ref="startup" fork="true" title="Synthetic investigation">${CHILD_TASK}</garcon-start-agent>`);
  return { cursor, turnId: accepted.turnId };
}

export async function waitForStartOutcome(
  fixture: IntegrationFixture, parent: string, status: AgentStartOutcomeNoticeDetail['status'], cursor: number,
): Promise<AgentStartOutcomeNoticeDetail> {
  const event = await fixture.client.waitForEvent(
    (event): event is ChatMessagesMessage => event.type === 'chat-messages' && event.chatId === parent
      && event.messages.some(({ message }) => message.type === 'transcript-notice'
        && message.detail?.type === 'agent-start-outcome' && message.detail.status === status),
    `delegated startup ${status}`, { afterIndex: cursor },
  );
  const detail = messagesOfType(event.messages, 'transcript-notice')
    .find((message) => message.detail?.type === 'agent-start-outcome' && message.detail.status === status)?.detail;
  if (detail?.type !== 'agent-start-outcome') throw new Error('Missing delegated startup outcome');
  return detail;
}

export async function startupPhases(fixture: IntegrationFixture, chatId: string) {
  return messagesOfType((await fixture.client.getMessages(chatId, { limit: 200 })).messages, 'transcript-notice')
    .flatMap((message) => message.detail?.type === 'agent-start-progress' ? [message.detail.phase] : []);
}
