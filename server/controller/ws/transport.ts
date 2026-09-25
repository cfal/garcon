interface WebSocketMessageSender {
  send(payload: string, compress?: boolean): number;
}

export interface WebSocketMessagePublisher {
  publish(topic: string, payload: string, compress?: boolean): number;
}

export const PRIMARY_WEBSOCKET_TRANSPORT_OPTIONS = {
  perMessageDeflate: true,
} as const;

// Bun negotiates compression at upgrade time and requires each data message to opt in.
const COMPRESS_OUTBOUND_MESSAGES = true;

export function sendWebSocketPayload(
  sender: WebSocketMessageSender,
  payload: string,
): number {
  return sender.send(payload, COMPRESS_OUTBOUND_MESSAGES);
}

export function publishWebSocketPayload(
  publisher: WebSocketMessagePublisher,
  topic: string,
  payload: string,
): number {
  return publisher.publish(topic, payload, COMPRESS_OUTBOUND_MESSAGES);
}
