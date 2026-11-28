import {
  ClientRequestErrorMessage,
  ReconnectStateMessage,
  WsPongMessage,
  parseServerWsMessage,
} from '../../../../../common/ws-events.ts';

export function processing(value: unknown): boolean {
  const message = parseServerWsMessage({
    type: 'ws-pong', clientRequestId: 'req', sentAt: 0, serverTime: 'now',
    processing: value, serverInstanceId: 'server-a',
  });
  return message instanceof WsPongMessage && JSON.stringify(message.processing) === JSON.stringify(value);
}

export function clientRequestErrorCode(value: unknown): boolean {
  return parseServerWsMessage({
    type: 'client-request-error', clientRequestId: 'req', requestType: 'request',
    code: value, message: '', retryable: false,
  }) instanceof ClientRequestErrorMessage;
}

export function controlResults(value: unknown): boolean {
  const serverInstanceId = Array.isArray(value)
    ? value.find((result) => result?.outcome === 'snapshot')?.control?.serverInstanceId ?? 'server-a'
    : 'server-a';
  const message = parseServerWsMessage({
    type: 'reconnect-state', processing: { outcome: 'unavailable' },
    controlResults: value, serverInstanceId,
  });
  return message instanceof ReconnectStateMessage
    && JSON.stringify(message.controlResults) === JSON.stringify(value);
}

export function finiteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}
