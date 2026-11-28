import {
  parseAgentHandoffCommandRequest, parseAgentRunCommandRequest, parseForkChatCommandRequest,
  parsePermissionDecisionCommandRequest, parseQueueEntryMoveCommandRequest, parseStartChatCommandRequest,
} from '../../../../common/chat-command-contracts.ts';
import type { ExecutorRpcMethods } from '../../../../server/remote/transport/rpc-protocol.ts';

if (Bun.version !== '1.4.3') throw new Error(`expected Bun 1.4.3, got ${Bun.version}`);

const chatId = '1783725900000000';
const sourceChatId = '1783725900000001';
const ids = { clientRequestId: ' request ', clientMessageId: ' message ', chatId };
const settings = { ownerId: 'codex', schemaVersion: 1, values: {} };
const permissionOccurrenceId = 'fixture-permission';
const permission = {
  ...ids, permissionOccurrenceId, allow: true, alwaysAllow: false,
  control: { serverInstanceId: 'fixture-instance', chatId, runId: 'fixture-run', permissionOccurrenceId },
  response: {
    type: 'ask-user-question-response', outcome: 'answered',
    answers: [{ questionId: 'fixture-question', selectedOptionIds: ['fixture-option'], text: ' reply ' }],
  },
};
const inputs = [
  {
    ...ids, origin: 'interactive', executorId: null, parentChatId: sourceChatId,
    agentId: 'codex', projectPath: '/work ', model: 'fixture-model', agentSettings: settings,
    apiProviderId: null, modelProtocol: 'openai-compatible',
    permissionMode: 'default', thinkingMode: 'low', command: ' keep whitespace ',
    images: [{ data: 'synthetic', name: 'fixture.png', mimeType: 'image/png' }],
    tags: ['Review Needed', ' QA '], orderedPreambleIds: [],
  },
  {
    ...ids, transcriptViewId: 'fixture-view', excludedResendOrdinals: [9, 2, 9],
    command: ' next ', model: 'fixture-model', apiProviderId: null, modelEndpointId: null,
    modelProtocol: null, expectedAgentId: 'codex', tagsToAdd: [' QA '], permissionFallbackPolicy: 'require-explicit-bypass',
  },
  {
    ...ids, handoff: {
      target: { executorId: null, projectPath: '/target ', agentId: 'codex', model: 'fixture-model',
        apiProviderId: 'fixture-provider', modelEndpointId: 'main', agentSettings: settings },
      expectedAgentOwnershipEpoch: 'fixture-epoch',
    },
  },
  {
    ...ids, sourceChatId, upToOrdinal: 4, transcriptViewId: 'fixture-view', allowHandoffFork: true,
  },
  {
    ...ids, entryId: 'fixture-entry', targetEntryId: 'fixture-target', placement: 'after',
    expectedReorderRevision: 0, expectedSourceRevision: 1, expectedTargetRevision: 2,
  },
  permission,
];
const parsers = [
  parseStartChatCommandRequest, parseAgentRunCommandRequest, parseAgentHandoffCommandRequest,
  parseForkChatCommandRequest, parseQueueEntryMoveCommandRequest, parsePermissionDecisionCommandRequest,
];
const { allow, alwaysAllow, response } = parsePermissionDecisionCommandRequest(permission);
const decision: ExecutorRpcMethods['permissions.respond']['request']['decision'] = { allow, alwaysAllow, response };
const rawDecision = '{"allow":true,"alwaysAllow":false,"response":{"10":10,"2":2,"n":1.0,"saturated":9007199254740993,"exp21":1e21,"negativeZero":-0}}';

console.log(JSON.stringify({
  requests: inputs.map((input, i) => ({ input: JSON.stringify(input), parsed: JSON.stringify(parsers[i](input)) })),
  decision: JSON.stringify(decision),
  rawDecision,
  providerDecision: JSON.stringify(JSON.parse(rawDecision)),
}));
