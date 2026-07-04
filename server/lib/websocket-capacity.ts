export function shouldRejectWebSocketUpgrade(pendingWebSockets: number, maxWebSocketClients: number): boolean {
  if (!Number.isFinite(maxWebSocketClients) || maxWebSocketClients < 1) return true;
  return pendingWebSockets >= maxWebSocketClients;
}

