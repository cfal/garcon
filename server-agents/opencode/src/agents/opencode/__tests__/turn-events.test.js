import { describe, expect, it } from 'bun:test';
import {
  activateOpenCodeSessionTurn,
  createOpenCodeTurnContext,
  openCodeTurnRequiresProviderQuiescence,
} from '../turn-events.js';

function operation(runId) {
  return { runId, publish() {} };
}

describe('OpenCode turn events', () => {
  it('clears retired-turn control state when a successor activates', () => {
    const previousTurn = createOpenCodeTurnContext(operation('run-previous'));
    const successorTurn = createOpenCodeTurnContext(operation('run-successor'));
    const session = {
      status: 'completed',
      aborting: true,
      chatId: 'chat-previous',
      model: 'provider/previous',
      thinkingVariant: 'high',
      permissionMode: 'default',
      directory: '/previous',
      startedAt: new Date(0).toISOString(),
      lastActivityAt: 0,
      providerWorkRequiresQuiescence: true,
      activeSteeringDeliveries: 1,
      deferredTerminal: { outcome: 'aborted', messageId: 'assistant-previous' },
      pendingSteeringRevertMessageId: null,
      turn: previousTurn,
    };

    activateOpenCodeSessionTurn(session, {
      chatId: 'chat-successor',
      model: 'provider/successor',
      thinkingVariant: 'low',
      permissionMode: 'plan',
      directory: '/successor',
      turn: successorTurn,
    });

    expect(session).toMatchObject({
      status: 'running',
      aborting: false,
      providerWorkRequiresQuiescence: false,
      activeSteeringDeliveries: 0,
      deferredTerminal: null,
      chatId: 'chat-successor',
      model: 'provider/successor',
      thinkingVariant: 'low',
      permissionMode: 'plan',
      directory: '/successor',
      turn: successorTurn,
    });
    expect(session.lastActivityAt).toBeGreaterThan(0);
  });

  it('derives quiescence from incomplete prompts and uncertain steering', () => {
    const turn = createOpenCodeTurnContext(operation('run-a'));
    expect(openCodeTurnRequiresProviderQuiescence(turn)).toBe(true);

    turn.providerPromptRequestCompleted = true;
    expect(openCodeTurnRequiresProviderQuiescence(turn)).toBe(false);

    turn.providerSteeringDeliveryUnconfirmed = true;
    expect(openCodeTurnRequiresProviderQuiescence(turn)).toBe(true);

    turn.providerSteeringDeliveryUnconfirmed = false;
    turn.pendingSteeringMessageIds.add('user-steer');
    expect(openCodeTurnRequiresProviderQuiescence(turn)).toBe(true);
  });
});
