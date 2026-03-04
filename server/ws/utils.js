const OPEN_WS_STATE = 1;

// Reuse a single TextDecoder instance instead of creating Buffer intermediaries.
const decoder = new TextDecoder();

function sendWebSocketMessage(ws, payload) {
  if (ws.readyState !== OPEN_WS_STATE) return false;
  ws.send(payload);
  return true;
}

export function sendWebSocketJson(ws, payload) {
  return sendWebSocketMessage(ws, JSON.stringify(payload));
}

export function decodeWebSocketMessage(message) {
  if (typeof message === 'string') return message;
  return decoder.decode(message);
}
