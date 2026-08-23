import { describe, expect, it, mock } from 'bun:test';
import { OpenCodeOperationRoutes } from '../operation-routes.js';
import {
  isOpenCodeCompactionContinuationPart,
  isOpenCodeCompactionControlPart,
} from '../sse-events.js';
import {
  createOpenCodeTurnContext,
  openCodeEventBelongsToTurn,
} from '../turn-events.js';

function createFixture() {
  const logger = {
    debug: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  };
  return { logger, routes: new OpenCodeOperationRoutes(logger) };
}

function createTurn(runId) {
  return createOpenCodeTurnContext({ runId, publish: mock(() => undefined) });
}

function register(routes, {
  sessionId,
  chatId,
  runId,
  supersedesChatSource = false,
}) {
  const turn = createTurn(runId);
  const route = routes.register(
    sessionId,
    chatId,
    turn,
    supersedesChatSource,
    'default',
    '/repo',
  );
  return { route, turn };
}

function promptEvent(turn, messageId, eventId) {
  return {
    id: eventId,
    type: 'message.part.updated',
    properties: {
      sessionID: 'ignored-by-routes',
      part: {
        id: turn.providerPromptPartId,
        messageID: messageId,
        type: 'text',
        text: `prompt-${turn.operation.runId}`,
      },
    },
  };
}

function assistantEvent(sessionId, messageId, parentId, eventId) {
  return {
    id: eventId,
    type: 'message.updated',
    properties: {
      sessionID: sessionId,
      info: { id: messageId, role: 'assistant', parentID: parentId },
    },
  };
}

function compactionPartEvent(part = {}) {
  return {
    id: 'event-compaction-part',
    type: 'message.part.updated',
    properties: {
      sessionID: 'session-1',
      part: {
        id: 'part-compaction',
        messageID: 'user-compaction',
        type: 'compaction',
        auto: true,
        ...part,
      },
    },
  };
}

function taskPartEvent(childSessionId, part = {}) {
  return {
    id: 'event-task-part',
    type: 'message.part.updated',
    properties: {
      sessionID: 'session-1',
      part: {
        id: 'part-task',
        messageID: 'assistant-task',
        type: 'tool',
        tool: 'task',
        state: {
          status: 'running',
          input: {},
          metadata: { sessionId: childSessionId },
        },
        ...part,
      },
    },
  };
}

function taskChildCreatedEvent(childSessionId, parentSessionId) {
  return {
    id: `event-created-${childSessionId}`,
    type: 'session.created',
    properties: {
      sessionID: childSessionId,
      info: { id: childSessionId, parentID: parentSessionId },
    },
  };
}

describe('OpenCodeOperationRoutes', () => {
  it('does not let a delayed prompt binding replace a newer source route', () => {
    const { routes } = createFixture();
    const first = register(routes, {
      sessionId: 'session-1',
      chatId: 'chat-1',
      runId: 'run-a',
      supersedesChatSource: true,
    });
    routes.observe(first.route, promptEvent(first.turn, 'user-a', 'event-a'));
    const second = register(routes, {
      sessionId: 'session-1',
      chatId: 'chat-1',
      runId: 'run-b',
    });
    routes.observe(second.route, promptEvent(second.turn, 'user-b', 'event-b'));

    routes.observe(first.route, promptEvent(first.turn, 'user-a', 'event-a-delayed'));

    expect(routes.resolveNamed('session-1', promptEvent(
      first.turn,
      'user-a',
      'event-a-replayed',
    ))).toBe(first.route);
    expect(routes.resolveNamed('session-1', promptEvent(
      second.turn,
      'user-b',
      'event-b-replayed',
    ))).toBe(second.route);
  });

  it('keeps named routes after a newer operation becomes the source', () => {
    const { routes } = createFixture();
    const first = register(routes, {
      sessionId: 'session-1',
      chatId: 'chat-1',
      runId: 'run-a',
    });
    routes.observe(first.route, promptEvent(first.turn, 'user-a', 'event-a'));
    const second = register(routes, {
      sessionId: 'session-1',
      chatId: 'chat-1',
      runId: 'run-b',
    });
    routes.observe(second.route, promptEvent(second.turn, 'user-b', 'event-b'));

    const lateFirst = assistantEvent('session-1', 'assistant-a', 'user-a', 'event-late-a');

    expect(routes.resolveNamed('session-1', lateFirst)).toBe(first.route);
    expect(routes.resolveNamed('session-1', promptEvent(
      second.turn,
      'user-b',
      'event-b-replayed',
    ))).toBe(second.route);
  });

  it('lets the exact prompt echo claim a user message observed under the prior source', () => {
    const { routes } = createFixture();
    const first = register(routes, {
      sessionId: 'session-1',
      chatId: 'chat-1',
      runId: 'run-a',
    });
    routes.observe(first.route, promptEvent(first.turn, 'user-a', 'event-a'));
    const second = register(routes, {
      sessionId: 'session-1',
      chatId: 'chat-1',
      runId: 'run-b',
    });
    routes.observe(first.route, {
      id: 'event-user-b-provisional',
      type: 'message.updated',
      properties: {
        sessionID: 'session-1',
        info: { id: 'user-b', role: 'user' },
      },
    });

    routes.observe(second.route, promptEvent(second.turn, 'user-b', 'event-b'));

    expect(routes.resolveNamed('session-1', assistantEvent(
      'session-1',
      'assistant-b',
      'user-b',
      'event-assistant-b',
    ))).toBe(second.route);
  });

  it('does not resolve unnamed events or cross session identity boundaries', () => {
    const { routes } = createFixture();
    const first = register(routes, {
      sessionId: 'session-a',
      chatId: 'chat-a',
      runId: 'run-a',
    });
    const second = register(routes, {
      sessionId: 'session-b',
      chatId: 'chat-b',
      runId: 'run-b',
    });
    routes.observe(first.route, promptEvent(first.turn, 'shared-user', 'event-a'));
    routes.observe(second.route, promptEvent(second.turn, 'shared-user', 'event-b'));
    const event = assistantEvent('session-a', 'shared-assistant', 'shared-user', 'event-output');

    expect(routes.resolveNamed('session-a', event)).toBe(first.route);
    expect(routes.resolveNamed('session-b', event)).toBe(second.route);
    expect(routes.resolveNamed('session-a', {
      id: 'event-unnamed',
      type: 'message.part.delta',
      properties: { sessionID: 'session-a', delta: 'text' },
    })).toBeNull();
  });

  it('[TLV5-L07.09-OPENCODE-UNIT-01] binds provider-generated continuations through inherited operation identity', () => {
    const { routes } = createFixture();
    const operation = register(routes, {
      sessionId: 'session-1',
      chatId: 'chat-1',
      runId: 'run-a',
    });
    routes.observe(operation.route, promptEvent(operation.turn, 'user-a', 'event-a'));
    const continuation = {
      id: 'event-continuation',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: {
          id: 'part-continuation',
          messageID: 'user-continuation',
          type: 'text',
          synthetic: true,
          metadata: { garcon_operation_part_id: operation.turn.providerPromptPartId },
        },
      },
    };
    expect(routes.resolve('session-1', continuation)).toBe(operation.route);
    expect(routes.resolveNamed('session-1', assistantEvent(
      'session-1',
      'assistant-continuation',
      'user-continuation',
      'event-assistant-continuation',
    ))).toBe(operation.route);
  });

  it('drops an unqualified provider continuation even when one session route exists', () => {
    const { routes } = createFixture();
    const operation = register(routes, {
      sessionId: 'session-1',
      chatId: 'chat-1',
      runId: 'run-a',
    });
    routes.observe(operation.route, promptEvent(operation.turn, 'user-a', 'event-a'));

    expect(routes.resolve('session-1', {
      id: 'event-unqualified-compaction',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: {
          id: 'part-unqualified-compaction',
          messageID: 'user-unqualified-compaction',
          type: 'compaction',
          auto: true,
        },
      },
    })).toBeNull();
  });

  it('uses inherited operation metadata without guessing between concurrent request sources', () => {
    const { routes } = createFixture();
    const first = register(routes, {
      sessionId: 'session-1',
      chatId: 'chat-1',
      runId: 'run-a',
    });
    const second = register(routes, {
      sessionId: 'session-1',
      chatId: 'chat-1',
      runId: 'run-b',
    });
    const replay = {
      id: 'event-replay',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: {
          id: 'part-replay',
          messageID: 'user-replay',
          type: 'text',
          metadata: { garcon_operation_part_id: first.turn.providerPromptPartId },
        },
      },
    };
    const unqualifiedContinuation = {
      id: 'event-ambiguous-continuation',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: {
          id: 'part-ambiguous-continuation',
          messageID: 'user-ambiguous-continuation',
          type: 'compaction',
          auto: true,
        },
      },
    };

    expect(routes.resolve('session-1', replay)).toBe(first.route);
    expect(routes.resolve('session-1', unqualifiedContinuation)).toBeNull();
    expect(routes.isRegistered(second.route)).toBe(true);
  });

  it('retires the prior chat source only after a fresh session binds', () => {
    const { routes } = createFixture();
    const prior = register(routes, {
      sessionId: 'session-old',
      chatId: 'chat-1',
      runId: 'run-a',
    });
    routes.observe(prior.route, promptEvent(prior.turn, 'user-a', 'event-a'));
    const unrelated = register(routes, {
      sessionId: 'session-other',
      chatId: 'chat-2',
      runId: 'run-other',
    });
    routes.observe(unrelated.route, promptEvent(unrelated.turn, 'user-other', 'event-other'));
    const replacement = register(routes, {
      sessionId: 'session-new',
      chatId: 'chat-1',
      runId: 'run-b',
      supersedesChatSource: true,
    });

    expect(routes.resolveNamed('session-old', assistantEvent(
      'session-old',
      'assistant-a',
      'user-a',
      'event-before-binding',
    ))).toBe(prior.route);

    routes.observe(
      replacement.route,
      promptEvent(replacement.turn, 'user-b', 'event-replacement'),
    );

    expect(routes.resolveNamed('session-old', assistantEvent(
      'session-old',
      'assistant-a',
      'user-a',
      'event-after-binding',
    ))).toBeNull();
    expect(routes.resolveNamed('session-other', assistantEvent(
      'session-other',
      'assistant-other',
      'user-other',
      'event-unrelated',
    ))).toBe(unrelated.route);
  });

  it('removes only a failed pending route', () => {
    const { routes } = createFixture();
    const established = register(routes, {
      sessionId: 'session-1',
      chatId: 'chat-1',
      runId: 'run-a',
    });
    routes.observe(established.route, promptEvent(established.turn, 'user-a', 'event-a'));
    const failed = register(routes, {
      sessionId: 'session-1',
      chatId: 'chat-1',
      runId: 'run-b',
    });

    routes.unregister(failed.route);

    expect(routes.resolveNamed('session-1', assistantEvent(
      'session-1',
      'assistant-a',
      'user-a',
      'event-late-a',
    ))).toBe(established.route);
    expect(routes.resolveNamed('session-1', promptEvent(
      failed.turn,
      'user-b',
      'event-failed',
    ))).toBeNull();
  });

  it('[TLV5-L07.10-OPENCODE-UNIT-01] retires every route when the provider event source closes', () => {
    const { routes } = createFixture();
    const established = register(routes, {
      sessionId: 'session-1',
      chatId: 'chat-1',
      runId: 'run-a',
    });
    routes.observe(established.route, promptEvent(established.turn, 'user-a', 'event-a'));
    expect(routes.bindPart(established.turn, 'steering-a')).toBe(true);

    routes.clear();

    expect(routes.bindPart(established.turn, 'steering-after-close')).toBe(false);
    expect(routes.resolveNamed('session-1', {
      id: 'event-steering-a',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: { id: 'steering-a', messageID: 'user-steering-a' },
      },
    })).toBeNull();
  });

  it('binds only a routed task part child session without a session fallback', () => {
    const { logger, routes } = createFixture();
    const parent = register(routes, {
      sessionId: 'session-1',
      chatId: 'chat-1',
      runId: 'run-a',
    });

    expect(routes.resolveTaskChild('child-1')).toBeNull();
    expect(routes.bindTaskChildSession(parent.route, taskPartEvent('child-1', {
      tool: 'bash',
    }))).toBe(false);
    expect(routes.bindTaskChildSession(parent.route, taskPartEvent('child-1', {
      state: { status: 'running', input: {}, metadata: {} },
    }))).toBe(false);
    expect(routes.bindTaskChildSession(parent.route, taskPartEvent('session-1'))).toBe(false);
    expect(routes.bindTaskChildSession(parent.route, taskPartEvent('child-1'))).toBe(true);
    expect(routes.resolveTaskChild('child-1')).toBe(parent.route);
    expect(routes.resolveTaskChild('unknown-child')).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('refuses child-session collisions and retires affiliations with the route', () => {
    const { logger, routes } = createFixture();
    const first = register(routes, {
      sessionId: 'session-1',
      chatId: 'chat-1',
      runId: 'run-a',
    });
    const second = register(routes, {
      sessionId: 'session-2',
      chatId: 'chat-2',
      runId: 'run-b',
    });

    expect(routes.bindTaskChildSession(first.route, taskPartEvent('child-shared'))).toBe(true);
    expect(routes.bindTaskChildSession(second.route, taskPartEvent('child-shared'))).toBe(false);
    expect(routes.bindTaskChildSession(first.route, taskPartEvent('session-2'))).toBe(false);
    expect(routes.resolveTaskChild('child-shared')).toBe(first.route);
    expect(logger.warn).toHaveBeenCalledTimes(2);

    routes.unregister(first.route);

    expect(routes.resolveTaskChild('child-shared')).toBeNull();
    expect(routes.bindTaskChildSession(second.route, taskPartEvent('child-shared'))).toBe(true);
    routes.clear();
    expect(routes.resolveTaskChild('child-shared')).toBeNull();
  });

  it('affiliates task descendants only through an already bound child parent', () => {
    const { logger, routes } = createFixture();
    const parent = register(routes, {
      sessionId: 'session-1',
      chatId: 'chat-1',
      runId: 'run-a',
    });

    expect(routes.bindTaskDescendantSession(taskChildCreatedEvent(
      'unaffiliated-child',
      'session-1',
    ))).toBeNull();
    expect(routes.bindTaskChildSession(parent.route, taskPartEvent('child-1'))).toBe(true);
    expect(routes.bindTaskDescendantSession(taskChildCreatedEvent(
      'grandchild-1',
      'child-1',
    ))).toBe(parent.route);
    expect(routes.bindTaskDescendantSession(taskChildCreatedEvent(
      'great-grandchild-1',
      'grandchild-1',
    ))).toBe(parent.route);
    expect(routes.resolveTaskChild('grandchild-1')).toBe(parent.route);
    expect(routes.resolveTaskChild('great-grandchild-1')).toBe(parent.route);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('recognizes only provider-marked automatic compaction control parts', () => {
    for (const event of [
      { ...compactionPartEvent(), type: 'message.part.delta' },
      compactionPartEvent({ type: 'text' }),
      compactionPartEvent({ auto: undefined }),
      compactionPartEvent({ auto: false }),
      compactionPartEvent({ auto: 'true' }),
    ]) {
      expect(isOpenCodeCompactionControlPart(event)).toBe(false);
    }

    expect(isOpenCodeCompactionControlPart(compactionPartEvent())).toBe(true);
    expect(isOpenCodeCompactionControlPart(compactionPartEvent({ overflow: false }))).toBe(true);
    expect(isOpenCodeCompactionControlPart(compactionPartEvent({ overflow: true }))).toBe(true);
  });

  it('recognizes only provider-marked automatic compaction continuation parts', () => {
    const continuation = (part = {}) => compactionPartEvent({
      type: 'text',
      auto: undefined,
      synthetic: true,
      metadata: { compaction_continue: true },
      ...part,
    });
    for (const event of [
      { ...continuation(), type: 'message.part.delta' },
      continuation({ type: 'file' }),
      continuation({ synthetic: undefined }),
      continuation({ synthetic: false }),
      continuation({ metadata: undefined }),
      continuation({ metadata: {} }),
      continuation({ metadata: { compaction_continue: false } }),
      continuation({ metadata: { compaction_continue: 'true' } }),
    ]) {
      expect(isOpenCodeCompactionContinuationPart(event)).toBe(false);
    }

    expect(isOpenCodeCompactionContinuationPart(continuation())).toBe(true);
    expect(isOpenCodeCompactionContinuationPart(continuation({
      metadata: { compaction_continue: true, provider_field: 'retained' },
    }))).toBe(true);
  });

  it('adopts an automatic compaction control part and resolves the invisible summary chain', () => {
    const { logger, routes } = createFixture();
    const operation = register(routes, {
      sessionId: 'session-1',
      chatId: 'chat-1',
      runId: 'run-a',
    });
    routes.observe(operation.route, promptEvent(operation.turn, 'user-a', 'event-a'));
    operation.turn.providerMessageId = 'user-a';

    expect(routes.adoptCompactionPart(operation.turn, compactionPartEvent())).toEqual({
      kind: 'adopted',
      route: operation.route,
    });
    const summary = {
      id: 'event-summary',
      type: 'message.updated',
      properties: {
        sessionID: 'session-1',
        info: {
          id: 'assistant-summary',
          role: 'assistant',
          parentID: 'user-compaction',
          summary: true,
          finish: 'stop',
          time: { completed: 1 },
        },
      },
    };
    expect(routes.resolveNamed('session-1', summary)).toBe(operation.route);
    expect(openCodeEventBelongsToTurn(operation.turn, summary)).toBe(false);
    routes.observe(operation.route, summary);

    const summaryPart = {
      id: 'event-summary-part',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: { id: 'part-summary', messageID: 'assistant-summary', type: 'text' },
      },
    };
    const summaryDelta = {
      id: 'event-summary-delta',
      type: 'message.part.delta',
      properties: {
        sessionID: 'session-1',
        messageID: 'assistant-summary',
        partID: 'part-summary',
        delta: 'synthetic summary content',
      },
    };
    expect(routes.resolveNamed('session-1', summaryPart)).toBe(operation.route);
    expect(routes.resolveNamed('session-1', summaryDelta)).toBe(operation.route);
    expect(openCodeEventBelongsToTurn(operation.turn, summaryPart)).toBe(false);
    expect(openCodeEventBelongsToTurn(operation.turn, summaryDelta)).toBe(false);
    expect(operation.turn.assistantMessageIds).not.toContain('assistant-summary');
    expect(operation.turn.assistantTerminals).toHaveLength(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('retires adopted compaction identities with their turn', () => {
    const { routes } = createFixture();
    const operation = register(routes, {
      sessionId: 'session-1',
      chatId: 'chat-1',
      runId: 'run-a',
    });
    const event = compactionPartEvent();
    expect(routes.adoptCompactionPart(operation.turn, event).kind).toBe('adopted');

    routes.retireTurn(operation.turn);

    expect(routes.resolveNamed('session-1', event)).toBeNull();
    expect(routes.adoptCompactionPart(operation.turn, event)).toEqual({
      kind: 'route-retired',
    });
  });

  it('refuses malformed and colliding compaction identities without logging', () => {
    const { logger, routes } = createFixture();
    const first = register(routes, {
      sessionId: 'session-1',
      chatId: 'chat-1',
      runId: 'run-a',
    });
    const second = register(routes, {
      sessionId: 'session-1',
      chatId: 'chat-2',
      runId: 'run-b',
    });
    expect(routes.adoptCompactionPart(first.turn, compactionPartEvent({ id: '' }))).toEqual({
      kind: 'invalid-identifiers',
    });
    expect(routes.adoptCompactionPart(first.turn, compactionPartEvent({ messageID: '' }))).toEqual({
      kind: 'invalid-identifiers',
    });
    expect(routes.bindPart(second.turn, 'part-collision')).toBe(true);

    expect(routes.adoptCompactionPart(first.turn, compactionPartEvent({
      id: 'part-collision',
      messageID: 'message-new',
    }))).toEqual({ kind: 'identity-collision' });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('preserves the metadata-inheritance collision warning', () => {
    const { logger, routes } = createFixture();
    const first = register(routes, {
      sessionId: 'session-1',
      chatId: 'chat-1',
      runId: 'run-a',
    });
    const second = register(routes, {
      sessionId: 'session-1',
      chatId: 'chat-2',
      runId: 'run-b',
    });
    expect(routes.bindPart(second.turn, 'part-collision')).toBe(true);
    let partIdReads = 0;
    let messageIdReads = 0;
    const part = {
      get id() {
        partIdReads += 1;
        return partIdReads <= 2 ? 'part-unbound' : 'part-collision';
      },
      get messageID() {
        messageIdReads += 1;
        return messageIdReads <= 2 ? 'message-unbound' : 'message-new';
      },
      type: 'text',
      metadata: { garcon_operation_part_id: first.turn.providerPromptPartId },
    };

    expect(routes.resolve('session-1', {
      id: 'event-inheritance-collision',
      type: 'message.part.updated',
      properties: { sessionID: 'session-1', part },
    })).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Ignoring an OpenCode operation identity collision',
      expect.objectContaining({
        sessionId: 'session-1',
        partId: 'part-collision',
        messageId: 'message-new',
      }),
    );
  });
});
