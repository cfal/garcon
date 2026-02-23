const OPEN_WS_STATE = 1;

function sendWebSocketMessage(ws, payload) {
  if (ws.readyState !== OPEN_WS_STATE) return false;
  ws.send(payload);
  return true;
}

export function sendWebSocketJson(ws, payload) {
  return sendWebSocketMessage(ws, JSON.stringify(payload));
}

export function decodeWebSocketMessage(message) {
  return typeof message === 'string' ? message : Buffer.from(message).toString('utf8');
}
