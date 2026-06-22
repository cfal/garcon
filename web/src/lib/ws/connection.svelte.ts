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

const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 6_000;
const HEARTBEAT_IMMEDIATE_PROBE_MS = 250;
const HEARTBEAT_JITTER_MS = 1_500;

export interface WsMessage {
	data: Record<string, unknown>;
	timestamp: number;
}

export type WsConnectionPhase =
	| 'idle'
	| 'connecting'
	| 'connected'
	| 'reconnecting'
	| 'offline'
	| 'failed'
	| 'destroyed';

export type WsConnectionIssue =
	| 'initial-connect'
	| 'socket-close'
	| 'socket-error'
	| 'heartbeat-timeout'
	| 'browser-offline'
	| 'browser-online'
	| 'visibility-visible'
	| 'connect-threw'
	| 'missing-auth'
	| 'manual-disconnect';

export interface WsConnectionStatus {
	phase: WsConnectionPhase;
	reason: WsConnectionIssue | null;
	episodeId: number;
	reconnectAttempt: number;
	nextRetryAt: number | null;
	lastConnectedAt: number | null;
	lastDisconnectedAt: number | null;
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

const INITIAL_CONNECTION_STATUS: WsConnectionStatus = {
	phase: 'idle',
	reason: null,
	episodeId: 0,
	reconnectAttempt: 0,
	nextRetryAt: null,
	lastConnectedAt: null,
	lastDisconnectedAt: null,
};

function buildWebSocketUrl(token: string | null): string {
	const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
	// We append a timestamp to the URL to bust the browser cache.
	// This is specifically required for mobile Safari, which can otherwise aggressively
	// cache the 101 Switching Protocols response and refuse to establish a new WebSocket
	// connection if the tab was suspended or encountered a momentary connection drop.
	const params = new URLSearchParams({ v: String(Date.now()) });
	if (token) params.set('token', token);
	return `${protocol}//${window.location.host}/ws?${params.toString()}`;
}

// crypto.randomUUID() is only available when window.isSecureContext is true,
// so we generate a random 16-byte hex string instead.
function generateRequestId() {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class WsConnection {
	#ws: WebSocket | null = null;
	#activeSocket: WebSocket | null = null;
	#messageLog: WsMessage[] = [];
	messageVersion: number = $state(0);
	isConnected: boolean = $state(false);
	connectionStatus: WsConnectionStatus = $state({ ...INITIAL_CONNECTION_STATUS });

	#cursors = new Set<DrainCursor>();
	#trimOffset = 0;
	#reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
	#reconnectAttempts = 0;
	#destroyed = false;
	#pendingRequests = new Map<string, PendingRequest>();
	#connectionWaiters = new Set<{
		resolve: () => void;
		reject: (err: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	}>();
	#visibilityHandler: (() => void) | null = null;
	#onlineHandler: (() => void) | null = null;
	#offlineHandler: (() => void) | null = null;
	#heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
	#heartbeatInFlight = false;
	#authDisabled = false;
	#hasEverConnected = false;
	#currentEpisodeId = 0;
	#lastDisconnectedAt: number | null = null;
	#nextConnectReason: WsConnectionIssue = 'initial-connect';

	constructor() {
		if (typeof window !== 'undefined') {
			this.#visibilityHandler = () => {
				if (this.#destroyed) return;
				if (document.visibilityState === 'hidden') {
					this.#clearHeartbeatTimer();
					return;
				}
				if (this.isConnected) {
					this.#scheduleHeartbeat(HEARTBEAT_IMMEDIATE_PROBE_MS);
				} else {
					this.#connectNow('visibility-visible');
				}
			};
			this.#onlineHandler = () => {
				if (!this.#destroyed) this.#connectNow('browser-online');
			};
			this.#offlineHandler = () => {
				if (!this.#destroyed) {
					this.#forceReconnect('browser-offline', { reconnectNow: false });
				}
			};
			window.addEventListener('visibilitychange', this.#visibilityHandler);
			window.addEventListener('online', this.#onlineHandler);
			window.addEventListener('offline', this.#offlineHandler);
		}
	}

	connect(token: string | null, authDisabled = false): void {
		if (this.#destroyed) return;
		this.#authDisabled = authDisabled;

		if (!token && !authDisabled) {
			console.warn('No authentication token found for WebSocket connection');
			this.#lastDisconnectedAt = Date.now();
			this.#setConnectionStatus({
				phase: 'failed',
				reason: 'missing-auth',
				nextRetryAt: null,
				lastDisconnectedAt: this.#lastDisconnectedAt,
			});
			return;
		}

		// Closes any existing socket before opening a new one.
		this.#closeExisting({ rejectPending: true });

		const reason = this.#nextConnectReason;
		this.#setConnectionStatus({
			phase: this.#hasEverConnected ? 'reconnecting' : 'connecting',
			reason,
			reconnectAttempt: this.#reconnectAttempts,
			nextRetryAt: null,
		});
		this.#nextConnectReason = this.#hasEverConnected ? 'socket-close' : 'initial-connect';

		try {
			const wsUrl = buildWebSocketUrl(token);
			const websocket = new WebSocket(wsUrl);
			this.#activeSocket = websocket;

			websocket.onopen = () => {
				if (!this.#isCurrentSocket(websocket)) return;
				const now = Date.now();
				this.isConnected = true;
				this.#hasEverConnected = true;
				this.#ws = websocket;
				this.#reconnectAttempts = 0;
				this.#setConnectionStatus({
					phase: 'connected',
					reason: null,
					reconnectAttempt: 0,
					nextRetryAt: null,
					lastConnectedAt: now,
				});
				this.#resolveAllWaiters();
				this.#scheduleHeartbeat(this.#nextHeartbeatDelay());
			};

			websocket.onmessage = (event: MessageEvent) => {
				if (!this.#isCurrentSocket(websocket)) return;
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
				if (!this.#isCurrentSocket(websocket)) return;
				const reason =
					this.connectionStatus.reason === 'socket-error' ? 'socket-error' : 'socket-close';
				this.#handleSocketClosed(reason);
			};

			websocket.onerror = (error) => {
				if (!this.#isCurrentSocket(websocket)) return;
				console.error('WebSocket error:', error);
				this.#setConnectionStatus({ reason: 'socket-error' });
			};
		} catch (error) {
			console.error('Error creating WebSocket connection:', error);
			const episodeId = this.#beginOutage();
			this.#setConnectionStatus({
				phase: 'failed',
				reason: 'connect-threw',
				episodeId,
				nextRetryAt: null,
				lastDisconnectedAt: this.#lastDisconnectedAt,
			});
			this.#scheduleReconnect('connect-threw', episodeId);
		}
	}

	disconnect(): void {
		this.#destroyed = true;
		this.#setConnectionStatus({
			phase: 'destroyed',
			reason: 'manual-disconnect',
			nextRetryAt: null,
		});
		this.#clearReconnectTimeout();
		this.#clearHeartbeatTimer();
		this.#rejectAllWaiters('WebSocket destroyed');
		this.#rejectAllPending();
		this.#closeExisting({ rejectPending: false });
		if (this.#visibilityHandler) {
			window.removeEventListener('visibilitychange', this.#visibilityHandler);
			this.#visibilityHandler = null;
		}
		if (this.#onlineHandler) {
			window.removeEventListener('online', this.#onlineHandler);
			this.#onlineHandler = null;
		}
		if (this.#offlineHandler) {
			window.removeEventListener('offline', this.#offlineHandler);
			this.#offlineHandler = null;
		}
	}

	#setConnectionStatus(status: Partial<WsConnectionStatus>): void {
		this.connectionStatus = {
			...this.connectionStatus,
			...status,
		};
	}

	#beginOutage(): number {
		const phase = this.connectionStatus.phase;
		const alreadyInOutage =
			phase === 'connecting' ||
			phase === 'reconnecting' ||
			phase === 'offline' ||
			phase === 'failed';

		if (!alreadyInOutage) {
			this.#currentEpisodeId += 1;
			this.#lastDisconnectedAt = Date.now();
			return this.#currentEpisodeId;
		}

		this.#lastDisconnectedAt ??= Date.now();
		return this.#currentEpisodeId;
	}

	#handleSocketClosed(reason: WsConnectionIssue): void {
		const episodeId = this.#beginOutage();
		this.#clearHeartbeatTimer();
		this.#heartbeatInFlight = false;
		this.isConnected = false;
		this.#ws = null;
		this.#activeSocket = null;
		this.#rejectAllPending();
		this.#scheduleReconnect(reason, episodeId);
	}

	/** Returns a promise that resolves when the WebSocket is connected.
	 *  Resolves immediately if already connected. Rejects on timeout or destroy. */
	waitForConnection(timeoutMs = 10_000): Promise<void> {
		if (this.isConnected) return Promise.resolve();
		if (this.#destroyed) return Promise.reject(new Error('WebSocket destroyed'));

		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#connectionWaiters.delete(waiter);
				reject(new Error('Timed out waiting for WebSocket connection'));
			}, timeoutMs);

			const waiter = { resolve, reject, timer };
			this.#connectionWaiters.add(waiter);
		});
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
	sendRequest<T = Record<string, unknown>>(msg: object, timeoutMs = 10_000): Promise<T> {
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

	#closeExisting(options: { rejectPending?: boolean } = {}): void {
		this.#clearReconnectTimeout();
		this.#clearHeartbeatTimer();
		this.#heartbeatInFlight = false;
		if (options.rejectPending) this.#rejectAllPending();
		const socket = this.#activeSocket ?? this.#ws;
		if (socket) {
			socket.onopen = null;
			socket.onmessage = null;
			socket.onclose = null;
			socket.onerror = null;
			if (socket.readyState !== WebSocket.CLOSED) socket.close();
			this.#activeSocket = null;
			this.#ws = null;
			this.isConnected = false;
		}
	}

	#isCurrentSocket(socket: WebSocket): boolean {
		return this.#activeSocket === socket;
	}

	#resolveAllWaiters(): void {
		for (const waiter of this.#connectionWaiters) {
			clearTimeout(waiter.timer);
			waiter.resolve();
		}
		this.#connectionWaiters.clear();
	}

	#rejectAllWaiters(reason: string): void {
		for (const waiter of this.#connectionWaiters) {
			clearTimeout(waiter.timer);
			waiter.reject(new Error(reason));
		}
		this.#connectionWaiters.clear();
	}

	#rejectAllPending(): void {
		for (const pending of this.#pendingRequests.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error('WebSocket disconnected'));
		}
		this.#pendingRequests.clear();
	}

	#scheduleHeartbeat(delayMs: number): void {
		this.#clearHeartbeatTimer();
		if (this.#destroyed || !this.isConnected) return;
		if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
		this.#heartbeatTimer = setTimeout(() => {
			void this.#sendHeartbeat();
		}, delayMs);
	}

	async #sendHeartbeat(): Promise<void> {
		if (this.#heartbeatInFlight || !this.isConnected || this.#destroyed) return;
		this.#heartbeatInFlight = true;
		try {
			const raw = await this.sendRequest<Record<string, unknown>>({
				type: 'ws-ping',
				sentAt: Date.now(),
			}, HEARTBEAT_TIMEOUT_MS);
			if (raw.type !== 'ws-pong') throw new Error('Unexpected heartbeat response');
			this.#heartbeatInFlight = false;
			this.#scheduleHeartbeat(this.#nextHeartbeatDelay());
		} catch {
			this.#heartbeatInFlight = false;
			this.#forceReconnect('heartbeat-timeout', { reconnectNow: true });
		}
	}

	#forceReconnect(reason: WsConnectionIssue, options: { reconnectNow: boolean }): void {
		console.warn(`WebSocket reconnecting: ${reason}`);
		const episodeId = this.#beginOutage();
		this.#rejectAllPending();
		this.#closeExisting({ rejectPending: false });
		this.isConnected = false;
		this.#setConnectionStatus({
			phase: reason === 'browser-offline' ? 'offline' : 'reconnecting',
			reason,
			episodeId,
			nextRetryAt: null,
			lastDisconnectedAt: this.#lastDisconnectedAt,
		});
		if (options.reconnectNow) this.#connectNow(reason);
	}

	#connectNow(reason: WsConnectionIssue): void {
		if (this.#destroyed) return;
		this.#reconnectAttempts = 0;
		this.#clearReconnectTimeout();
		this.#nextConnectReason = reason;
		this.connect(getAuthToken(), this.#authDisabled);
	}

	#nextHeartbeatDelay(): number {
		return HEARTBEAT_INTERVAL_MS + Math.floor(Math.random() * HEARTBEAT_JITTER_MS);
	}

	#scheduleReconnect(
		reason: WsConnectionIssue = 'socket-close',
		episodeId = this.#currentEpisodeId,
	): void {
		if (this.#destroyed) return;
		this.#clearReconnectTimeout();

		const delay = Math.min(
			RECONNECT_BASE_MS * Math.pow(2, this.#reconnectAttempts),
			RECONNECT_MAX_MS,
		);
		const attempt = this.#reconnectAttempts + 1;
		const nextRetryAt = Date.now() + delay;
		this.#reconnectAttempts = attempt;

		const currentPhase = this.connectionStatus.phase;
		const phase =
			currentPhase === 'offline' || currentPhase === 'failed' ? currentPhase : 'reconnecting';
		this.#setConnectionStatus({
			phase,
			reason,
			episodeId,
			reconnectAttempt: attempt,
			nextRetryAt,
			lastDisconnectedAt: this.#lastDisconnectedAt,
		});

		this.#reconnectTimeout = setTimeout(() => {
			if (this.#destroyed) return;
			const token = getAuthToken();
			this.#nextConnectReason = reason;
			this.connect(token, this.#authDisabled);
		}, delay);
	}

	#clearReconnectTimeout(): void {
		if (this.#reconnectTimeout !== null) {
			clearTimeout(this.#reconnectTimeout);
			this.#reconnectTimeout = null;
		}
	}

	#clearHeartbeatTimer(): void {
		if (this.#heartbeatTimer !== null) {
			clearTimeout(this.#heartbeatTimer);
			this.#heartbeatTimer = null;
		}
	}
}

export function createWsConnection(): WsConnection {
	return new WsConnection();
}
