import { describe, expect, it, mock } from 'bun:test';
import { ChatIdDiscoveryController } from '../chat-id-discovery-controller.ts';
import { ChatIdDiscoveryState } from '../chat-id-discovery-state.ts';
import { transcriptViewId } from '../../ledger/contracts.ts';

const CHAT_ID = '1787836573296800';
const VIEW = transcriptViewId('view-1');

function harness() {
  const state = new ChatIdDiscoveryState(() => true);
  const appendNotice = mock(() => undefined);
  const onRecordError = mock(() => undefined);
  return {
    state,
    appendNotice,
    onRecordError,
    controller: new ChatIdDiscoveryController({
      state,
      notices: { appendNotice },
      onRecordError,
    }),
  };
}

describe('chat ID discovery controller', () => {
  it('reserves one suffix and records its exact delivery notice', () => {
    const { state, controller, appendNotice } = harness();
    state.request(CHAT_ID, VIEW);

    const prepared = controller.reserve(CHAT_ID, VIEW, 'continue');
    expect(prepared.prompt).toBe(
      `continue\n\n<garcon-chat-id>${CHAT_ID}</garcon-chat-id>`,
    );
    expect(controller.reserve(CHAT_ID, VIEW, 'overlap')).toEqual({
      prompt: 'overlap',
      reservation: null,
    });

    controller.recordDelivered(prepared.reservation, 'steer');
    expect(appendNotice).toHaveBeenCalledWith(CHAT_ID, VIEW, {
      title: 'Response: Garcon Chat ID',
      content: `Sent chat ID ${CHAT_ID} to agent (steer)`,
      detail: { type: 'chat-id-disclosure', delivery: 'steer' },
    });
    expect(controller.reserve(CHAT_ID, VIEW, 'later').reservation).toBeNull();
  });

  it('rearms the request when notice recording fails', () => {
    const { state, controller, appendNotice, onRecordError } = harness();
    appendNotice.mockImplementation(() => { throw new Error('ledger failed'); });
    state.request(CHAT_ID, VIEW);
    const prepared = controller.reserve(CHAT_ID, VIEW, 'continue');

    expect(() => controller.recordDelivered(prepared.reservation, 'input')).not.toThrow();
    expect(onRecordError).toHaveBeenCalledTimes(1);
    expect(controller.reserve(CHAT_ID, VIEW, 'retry').reservation).not.toBeNull();
  });
});
