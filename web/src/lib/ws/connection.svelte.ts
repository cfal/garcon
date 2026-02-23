// Manages a single WebSocket connection with automatic reconnection,
// a shared message log, and cooperative log trimming across multiple
// drain consumers.

import { getAuthToken } from '$lib/api/client';

// Trims the message log once all registered consumers have drained
// past this many entries. Keeps memory bounded on long-running sessions.
const TRIM_THRESHOLD = 500;

// Base delay for exponential backoff reconnection (ms).
const RECONNECT_BASE_MS = 3000;

// Maximum reconnection delay (ms).
const RECONNECT_MAX_MS = 30000;

export interface WsMessage {
  data: Record<string, unknown>;
  timestamp: number;
}

/** Cursor reference registered by each drain consumer. */
export interface DrainCursor {
  current: number;
}

interface PendingRequest {
  resolve: (data: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function buildWebSocketUrl(token: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // We append a timestamp to the URL to bust the browser cache.
  // This is specifically required for mobile Safari, which can otherwise aggressively
  // cache the 101 Switching Protocols response and refuse to establish a new WebSocket
  // connection if the tab was suspended or encountered a momentary connection drop.
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}&v=${Date.now()}`;
}

// crypto.randomUUID() is only available when window.isSecureContext is true,
// so we generate a random 16-byte hex string instead.
function generateRequestId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export class WsConnection {
  #ws: WebSocket | null = $state(null);
  #messageLog: WsMessage[] = $state([]);
  messageVersion: number = $state(0);
  isConnected: boolean = $state(false);

  #cursors = new Set<DrainCursor>();
  #trimOffset = 0;
  #reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  #reconnectAttempts = 0;
  #destroyed = false;
  #pendingRequests = new Map<string, PendingRequest>();
  #visibilityHandler: (() => void) | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      this.#visibilityHandler = () => {
        // Reconnect fast when the app resumes on iOS/Safari
        if (document.visibilityState === 'visible' && !this.isConnected && !this.#destroyed) {
          this.#reconnectAttempts = 0;
          this.#clearReconnectTimeout();
          const token = getAuthToken();
          if (token) this.connect(token);
        }
      };
      window.addEventListener('visibilitychange', this.#visibilityHandler);
    }
  }

  connect(token: string | null): void {
    if (this.#destroyed) return;

    if (!token) {
      console.warn('No authentication token found for WebSocket connection');
      return;
    }

    // Close any existing socket before opening a new one.
    this.#closeExisting();

    try {
      const wsUrl = buildWebSocketUrl(token);
      const websocket = new WebSocket(wsUrl);

      websocket.onopen = () => {
        this.isConnected = true;
        this.#ws = websocket;
        this.#reconnectAttempts = 0;
      };

      websocket.onmessage = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data as string) as Record<string, unknown>;

          // Resolve pending request-response correlation before
          // pushing to the shared log. Correlated responses are
          // consumed here and never dispatched to the event router.
          const rid = data.clientRequestId as string | undefined;
          if (rid && this.#pendingRequests.has(rid)) {
            const pending = this.#pendingRequests.get(rid)!;
            this.#pendingRequests.delete(rid);
            clearTimeout(pending.timer);

            if (data.type === 'client-request-error') {
              pending.reject(new Error(`${String(data.code)}: ${String(data.message)}`));
            } else {
              pending.resolve(data);
            }
            return;
          }

          this.#messageLog.push({ data, timestamp: Date.now() });
          this.#tryTrim();
          this.messageVersion++;
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      websocket.onclose = () => {
        this.isConnected = false;
        this.#ws = null;
        this.#scheduleReconnect();
      };

      websocket.onerror = (error) => {
        console.error('WebSocket error:', error);
      };
    } catch (error) {
      console.error('Error creating WebSocket connection:', error);
    }
  }

  disconnect(): void {
    this.#destroyed = true;
    this.#clearReconnectTimeout();
    this.#rejectAllPending();
    this.#closeExisting();
    if (this.#visibilityHandler) {
      window.removeEventListener('visibilitychange', this.#visibilityHandler);
      this.#visibilityHandler = null;
    }
  }

  /** Sends a JSON-serializable message. Returns true if sent. */
  sendMessage(msg: unknown): boolean {
    const socket = this.#ws;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
      return true;
    }
    console.warn('WebSocket not connected');
    return false;
  }

  /** Sends a request and returns a Promise resolved by a matching clientRequestId response. */
  sendRequest<T = Record<string, unknown>>(
    msg: object,
    timeoutMs = 10_000,
  ): Promise<T> {
    const clientRequestId = generateRequestId();
    const payload = { ...(msg as Record<string, unknown>), clientRequestId };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingRequests.delete(clientRequestId);
        reject(new Error(`WS request timed out: ${String((msg as Record<string, unknown>).type)}`));
      }, timeoutMs);

      this.#pendingRequests.set(clientRequestId, {
        resolve: resolve as (data: Record<string, unknown>) => void,
        reject,
        timer,
      });

      if (!this.sendMessage(payload)) {
        this.#pendingRequests.delete(clientRequestId);
        clearTimeout(timer);
        reject(new Error('WebSocket not connected'));
      }
    });
  }

  /** Registers a drain cursor for cooperative trimming. Returns a cleanup function. */
  registerCursor(cursor: DrainCursor): () => void {
    this.#cursors.add(cursor);
    return () => {
      this.#cursors.delete(cursor);
    };
  }

  get messages(): WsMessage[] {
    return this.#messageLog;
  }

  get trimOffset(): number {
    return this.#trimOffset;
  }

  // Trims the front of the message log when all registered consumers
  // have drained past TRIM_THRESHOLD entries.
  #tryTrim(): void {
    const cursors = this.#cursors;
    if (cursors.size === 0) return;

    const offset = this.#trimOffset;
    let minCursor = Infinity;
    for (const c of cursors) {
      if (c.current < minCursor) minCursor = c.current;
    }

    const minLocal = minCursor - offset;
    if (minLocal >= TRIM_THRESHOLD) {
      this.#messageLog.splice(0, minLocal);
      this.#trimOffset += minLocal;
    }
  }

  #closeExisting(): void {
    this.#clearReconnectTimeout();
    if (this.#ws) {
      this.#ws.onopen = null;
      this.#ws.onmessage = null;
      this.#ws.onclose = null;
      this.#ws.onerror = null;
      this.#ws.close();
      this.#ws = null;
      this.isConnected = false;
    }
  }

  #rejectAllPending(): void {
    for (const [id, pending] of this.#pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('WebSocket disconnected'));
    }
    this.#pendingRequests.clear();
  }

  #scheduleReconnect(): void {
    if (this.#destroyed) return;
    this.#clearReconnectTimeout();

    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.#reconnectAttempts),
      RECONNECT_MAX_MS,
    );
    this.#reconnectAttempts++;

    this.#reconnectTimeout = setTimeout(() => {
      if (this.#destroyed) return;
      const token = getAuthToken();
      this.connect(token);
    }, delay);
  }

  #clearReconnectTimeout(): void {
    if (this.#reconnectTimeout !== null) {
      clearTimeout(this.#reconnectTimeout);
      this.#reconnectTimeout = null;
    }
  }
}

export function createWsConnection(): WsConnection {
  return new WsConnection();
}
