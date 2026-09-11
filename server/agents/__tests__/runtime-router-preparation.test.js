import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { UserMessage } from '../../../common/chat-types.js';
import { createLocatedInstanceFixture, LOCATED_AT, LOCATED_CHATS } from './located-instance-fixture.js';

let fixture;
const chatId = LOCATED_CHATS.secondary;
beforeEach(async () => {
  fixture = await createLocatedInstanceFixture();
  await fixture.adoption.ensure(chatId);
  fixture.secondary.integration.settings.parse.mockClear();
});
afterEach(async () => { await fixture.dispose(); });

function options() {
  return { clientRequestId: 'synthetic-request', clientMessageId: 'synthetic-input', turnId: 'synthetic-turn',
    transcriptViewId: fixture.ledger.currentView(chatId).viewId, commandType: 'agent-run' };
}

test('prepares configuration once before admission and dispatches that capability', async () => {
  const request = options();
  const ticket = await fixture.agents.prepareTurn(chatId, request, new AbortController().signal);
  const provider = fixture.secondary.integration;
  expect(provider.settings.parse).toHaveBeenCalledOnce();
  expect(provider.execution.resume).not.toHaveBeenCalled();
  await fixture.agents.admitInput(chatId, new UserMessage(LOCATED_AT, 'synthetic input'), {
    ...request, validateBeforeCommit: ticket.validate,
  });
  await fixture.agents.runAgentTurn(chatId, 'synthetic input', { ...request, preparedExecution: ticket });
  expect(provider.settings.parse).toHaveBeenCalledOnce();
  expect(provider.execution.resume).toHaveBeenCalledOnce();
  await expect(fixture.agents.runAgentTurn(chatId, 'synthetic input', { ...request, preparedExecution: ticket }))
    .rejects.toThrow('Prepared execution turn is invalid');
});

test.each(['model', 'thinkingMode', 'modelProtocol', 'agentOwnershipEpoch', 'projectPath', 'nativeSession'])('rejects changed %s before admission without losing the prior transcript', async (field) => {
  const request = options();
  const ticket = await fixture.agents.prepareTurn(chatId, request, new AbortController().signal);
  if (field === 'nativeSession') fixture.agents.publishSessionFact(chatId, {
    agentSessionId: 'colliding-session', nativeSeedReceipt: null,
    nativeSession: { ownerId: 'test', schemaVersion: 1, value: { id: 'changed-native' } },
  });
  else fixture.chats.updateChat(chatId, {
    [field]: field === 'projectPath' ? '/synthetic-changed'
      : field === 'thinkingMode' ? 'low'
      : field === 'modelProtocol' ? 'openai-compatible' : 'synthetic-changed',
    ...(field === 'projectPath' ? { executionLocation: fixture.chats.getChat(chatId).executionLocation } : {}),
  });
  const before = fixture.ledger.currentRows(chatId);
  await expect(fixture.agents.admitInput(chatId, new UserMessage(LOCATED_AT, 'synthetic input'), {
    ...request, validateBeforeCommit: ticket.validate,
  })).rejects.toMatchObject({ code: 'SESSION_BUSY', retryable: true });
  expect(fixture.ledger.currentRows(chatId)).toEqual(before);
  ticket.release();
  expect(fixture.secondary.integration.execution.resume).not.toHaveBeenCalled();
});

test.each(['direct', 'queued'])('keeps the admitted %s configuration when settings change before dispatch', async (delivery) => {
  const request = options();
  const ticket = await fixture.agents.prepareTurn(chatId, request, new AbortController().signal);
  const admit = delivery === 'queued' ? 'admitQueuedInput' : 'admitInput';
  expect(await fixture.agents[admit](chatId, new UserMessage(LOCATED_AT, 'synthetic input'), {
    ...request, validateBeforeCommit: ticket.validate,
  })).toEqual({ inserted: true });
  fixture.chats.updateChat(chatId, { model: 'synthetic-later-model',
    agentSettingsById: { test: { ownerId: 'test', schemaVersion: 1, values: { profile: 'later' } } },
  });
  await fixture.agents.runAgentTurn(chatId, 'synthetic input', { ...request, preparedExecution: ticket });
  const provider = fixture.secondary.integration;
  expect(provider.execution.resume.mock.calls[0][0]).toMatchObject({
    model: 'synthetic-model', settings: { values: { parsedBy: 'secondary' } },
  });
  expect(provider.execution.resume.mock.calls[0][0].settings.values.profile).toBeUndefined();
  provider.execution.resume.mock.calls[0][0].output.emit({ type: 'run-ended', runId: request.turnId, outcome: 'finished' });
  await fixture.agents.runAgentTurn(chatId, 'synthetic next input', { turnId: 'synthetic-next-turn' });
  expect(provider.execution.resume.mock.calls[1][0]).toMatchObject({
    model: 'synthetic-later-model', settings: { values: { profile: 'later' } },
  });
});

test.each(['agentOwnershipEpoch', 'projectPath', 'nativeSession'])('still rejects changed %s after admission', async (field) => {
  const request = options();
  const ticket = await fixture.agents.prepareTurn(chatId, request, new AbortController().signal);
  await fixture.agents.admitInput(chatId, new UserMessage(LOCATED_AT, 'synthetic input'), {
    ...request, validateBeforeCommit: ticket.validate,
  });
  if (field === 'nativeSession') fixture.agents.publishSessionFact(chatId, {
    agentSessionId: 'colliding-session', nativeSeedReceipt: null,
    nativeSession: { ownerId: 'test', schemaVersion: 1, value: { id: 'changed-native' } },
  });
  else fixture.chats.updateChat(chatId, {
    [field]: field === 'projectPath' ? '/synthetic-changed' : 'synthetic-changed',
    ...(field === 'projectPath' ? { executionLocation: fixture.chats.getChat(chatId).executionLocation } : {}),
  });
  await expect(fixture.agents.runAgentTurn(chatId, 'synthetic input', { ...request, preparedExecution: ticket }))
    .rejects.toMatchObject({ code: 'SESSION_BUSY' });
  expect(fixture.secondary.integration.execution.resume).not.toHaveBeenCalled();
});

test('a delayed start handle cannot overwrite settings saved while it was launching', async () => {
  const startingChatId = LOCATED_CHATS.primary;
  fixture.chats.updateChat(startingChatId, { agentSessionId: null, nativeSession: null });
  const entered = Promise.withResolvers();
  const returned = Promise.withResolvers();
  const provider = fixture.primary.integration;
  provider.execution.start.mockImplementation(async () => { entered.resolve(); return returned.promise; });
  const pending = fixture.agents.runAgentTurn(startingChatId, 'synthetic start', { turnId: 'synthetic-start' });
  await entered.promise;
  fixture.chats.updateChat(startingChatId, { model: 'synthetic-later-model' });
  returned.resolve(fixture.primary.handle);
  await pending;
  expect(provider.execution.start.mock.calls[0][0].model).toBe('synthetic-model');
  expect(fixture.chats.getChat(startingChatId).model).toBe('synthetic-later-model');
});

test('an already committed same-ID retry bypasses preparation revalidation and cannot dispatch twice', async () => {
  const request = options();
  const message = new UserMessage(LOCATED_AT, 'synthetic input');
  await fixture.agents.admitInput(chatId, message, request);
  const validate = mock(() => { throw new Error('synthetic stale preparation'); });
  expect(await fixture.agents.admitInput(chatId, message, { ...request, validateBeforeCommit: validate }))
    .toEqual({ inserted: false });
  expect(validate).not.toHaveBeenCalled();
  expect(fixture.secondary.integration.execution.resume).not.toHaveBeenCalled();
});

test('releasing unused preparation makes it unusable before a run can begin', async () => {
  const request = options();
  const before = fixture.ledger.currentRows(chatId);
  const ticket = await fixture.agents.prepareTurn(chatId, request, new AbortController().signal);
  ticket.release();
  ticket.release();
  await expect(fixture.agents.runAgentTurn(chatId, 'synthetic input', { ...request, preparedExecution: ticket }))
    .rejects.toThrow('Prepared execution turn is invalid');
  expect(fixture.ledger.isRunActive(chatId)).toBe(false);
  expect(fixture.ledger.currentRows(chatId)).toEqual(before);
  expect(fixture.secondary.integration.execution.resume).not.toHaveBeenCalled();
});

test('resolves omitted configuration from the binding captured after adoption finishes', async () => {
  const entered = Promise.withResolvers();
  const ready = Promise.withResolvers();
  const ensure = fixture.adoption.ensure.bind(fixture.adoption);
  fixture.adoption.ensure = async (...args) => {
    entered.resolve();
    await ready.promise;
    return ensure(...args);
  };
  const request = options();
  const pending = fixture.agents.prepareTurn(chatId, request, new AbortController().signal);
  await entered.promise;
  fixture.chats.updateChat(chatId, { model: 'synthetic-new-model',
    agentSettingsById: { test: { ownerId: 'test', schemaVersion: 1, values: { profile: 'synthetic-new-profile' } } },
  });
  ready.resolve();
  const preparedExecution = await pending;
  await fixture.agents.runAgentTurn(chatId, 'synthetic input', { ...request, preparedExecution });
  expect(fixture.secondary.integration.execution.resume.mock.calls[0][0]).toMatchObject({
    model: 'synthetic-new-model', settings: { values: { profile: 'synthetic-new-profile' } },
  });
});

test('a successor during steer admission rejects the prepared occurrence before the input commits', async () => {
  await fixture.agents.runAgentTurn(chatId, 'synthetic input', options());
  const target = fixture.agents.captureSteerTarget(chatId);
  const validateBeforeCommit = await fixture.agents.prepareSteerTarget(chatId, target);
  const entered = Promise.withResolvers();
  const ready = Promise.withResolvers();
  const ensure = fixture.adoption.ensure.bind(fixture.adoption);
  fixture.adoption.ensure = async (...args) => {
    entered.resolve();
    await ready.promise;
    return ensure(...args);
  };
  const pending = fixture.agents.admitInput(chatId, new UserMessage(LOCATED_AT, 'synthetic rejected steer'), {
    ...options(), commandType: 'steer', clientMessageId: 'synthetic-steer', validateBeforeCommit,
  });
  await entered.promise;
  fixture.secondary.integration.execution.resume.mock.calls[0][0].output.emit({
    type: 'run-ended', runId: options().turnId, outcome: 'finished',
  });
  fixture.adoption.ensure = ensure;
  await fixture.agents.runAgentTurn(chatId, 'synthetic successor', { ...options(), turnId: 'synthetic-successor' });
  const before = fixture.ledger.currentRows(chatId);
  ready.resolve();
  await expect(pending).rejects.toMatchObject({ code: 'STEER_TURN_CHANGED' });
  expect(fixture.ledger.currentRows(chatId)).toEqual(before);
  expect(fixture.secondary.integration.steering.steer).not.toHaveBeenCalled();
});

test.each([
  ['unsupported', 'OPERATION_UNSUPPORTED', 422],
  ['unavailable', 'STEER_TURN_UNAVAILABLE', 409],
])('preserves the %s steering refusal without admitting input', async (refusal, code, status) => {
  if (refusal === 'unsupported') fixture.secondary.integration.steering = null;
  else fixture.secondary.integration.steering.captureTarget.mockImplementation(() => null);
  await fixture.agents.runAgentTurn(chatId, 'synthetic input', options());
  const before = fixture.ledger.currentRows(chatId);
  const target = fixture.agents.captureSteerTarget(chatId);
  expect(target).not.toBeNull();
  await expect(fixture.agents.prepareSteerTarget(chatId, target)).rejects.toMatchObject({ code, status });
  expect(fixture.ledger.currentRows(chatId)).toEqual(before);
});
