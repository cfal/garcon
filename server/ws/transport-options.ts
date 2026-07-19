// Keeps frequent full-duplex terminal frames out of the WebSocket compression path.
// Historical context (fixed in iOS 15.4): https://bugs.webkit.org/show_bug.cgi?id=228296.
export const PRIMARY_WEBSOCKET_TRANSPORT_OPTIONS = {
  perMessageDeflate: false,
} as const;
