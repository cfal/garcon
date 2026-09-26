import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { ChatReloadedMessage, ClientRequestErrorMessage } from '../../../common/ws-events.js';
import { GarconWsRequestError, type GarconTestClient } from '../../support/garcon-client.js';
import { reloadFromNativeHistory } from '../../support/live-agent.js';

afterEach(() => mock.restore());

const remoteBusy = 'The turn is still running on the executor. Reload from native history after it finishes.';

test.each(['CHAT_RUNNING', 'HISTORY_LOAD_FAILED'] as const)('Reload waits for %s idle admission', async code => {
  const sleep = spyOn(Bun, 'sleep').mockResolvedValue(undefined);
  const refusal = new GarconWsRequestError(new ClientRequestErrorMessage('request', 'chat-reload', code, remoteBusy, true, 'chat'));
  const response = new ChatReloadedMessage('request', 'chat', 'view', [], 0, 0, 0, null, false);
  const client = { reloadChat: mock(async () => response).mockRejectedValueOnce(refusal) } satisfies Pick<GarconTestClient, 'reloadChat'>;
  await reloadFromNativeHistory({ client }, 'chat');
  expect(client.reloadChat).toHaveBeenCalledTimes(2);
  expect(sleep).toHaveBeenCalledWith(1000);
});

test.each([
  { message: 'Synthetic history read failure', retryable: true },
  { message: remoteBusy, retryable: false },
])('Reload does not hide other history failures: %j', async ({ message, retryable }) => {
  const sleep = spyOn(Bun, 'sleep').mockResolvedValue(undefined);
  const refusal = new GarconWsRequestError(new ClientRequestErrorMessage('request', 'chat-reload', 'HISTORY_LOAD_FAILED', message, retryable, 'chat'));
  const client = { reloadChat: mock(async () => { throw refusal; }) } satisfies Pick<GarconTestClient, 'reloadChat'>;
  await expect(reloadFromNativeHistory({ client }, 'chat')).rejects.toBe(refusal);
  expect(client.reloadChat).toHaveBeenCalledTimes(1);
  expect(sleep).not.toHaveBeenCalled();
});

test('Reload stops retrying remote busy admission at its deadline', async () => {
  const sleep = spyOn(Bun, 'sleep').mockResolvedValue(undefined);
  spyOn(Date, 'now').mockReturnValue(30_000).mockReturnValueOnce(0);
  const refusal = new GarconWsRequestError(new ClientRequestErrorMessage('request', 'chat-reload', 'HISTORY_LOAD_FAILED', remoteBusy, true, 'chat'));
  const client = { reloadChat: mock(async () => { throw refusal; }) } satisfies Pick<GarconTestClient, 'reloadChat'>;
  await expect(reloadFromNativeHistory({ client }, 'chat')).rejects.toBe(refusal);
  expect(client.reloadChat).toHaveBeenCalledTimes(1);
  expect(sleep).not.toHaveBeenCalled();
});
