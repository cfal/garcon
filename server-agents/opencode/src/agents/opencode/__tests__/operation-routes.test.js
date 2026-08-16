import { describe, expect, it, mock } from 'bun:test';
import { OpenCodeOperationRoutes } from '../operation-routes.js';
import { createOpenCodeTurnContext } from '../turn-events.js';

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
  return createOpenCodeTurnContext(
    { clientRequestId: runId, turnId: runId },
    { runId, publish: mock(() => undefined) },
  );
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

  it('binds provider-generated compaction continuations to their sole request source', () => {
    const { routes } = createFixture();
    const operation = register(routes, {
      sessionId: 'session-1',
      chatId: 'chat-1',
      runId: 'run-a',
    });
    routes.observe(operation.route, promptEvent(operation.turn, 'user-a', 'event-a'));
    const compaction = {
      id: 'event-compaction',
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-1',
        part: {
          id: 'part-compaction',
          messageID: 'user-compaction',
          type: 'compaction',
          auto: true,
        },
      },
    };

    expect(routes.resolve('session-1', compaction)).toBe(operation.route);
    expect(routes.resolveNamed('session-1', assistantEvent(
      'session-1',
      'assistant-compaction',
      'user-compaction',
      'event-assistant-compaction',
    ))).toBe(operation.route);

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

  it('retires every route when the provider event source closes', () => {
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
});
