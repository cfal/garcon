// Manages a single WebSocket connection with automatic reconnection,
// a shared message log, and cooperative log trimming across multiple
// drain consumers.

import { getAuthToken } from '$lib/api/client';
import { webSocketProtocolsForAuth } from '$shared/ws-auth';
import type { PrimaryWsClientMessage } from '$shared/ws-protocol';
import { createRandomId } from '$lib/utils/random-id';
import { reconnectDelayMs } from './reconnect-policy';

// Trims the message log once all registered consumers have drained
// past this many entries. Keeps memory bounded on long-running sessions.
const TRIM_THRESHOLD = 500;

const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 6_000;
const HEARTBEAT_IMMEDIATE_PROBE_MS = 250;
const HEARTBEAT_JITTER_MS = 1_500;
const CONNECTION_STABILITY_MS = 10_000;
const CONNECT_ATTEMPT_DEDUPE_MS = 2_000;

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

export type WsMessageConsumer = (data: Record<string, unknown>) => boolean;
export type WsConnectionListener = (connected: boolean) => void;

export interface PrimaryWsConnectionPort {
	readonly isConnected: boolean;
	sendMessage(message: PrimaryWsClientMessage): boolean;
	addMessageConsumer(consumer: WsMessageConsumer): () => void;
	onConnectionChange(listener: WsConnectionListener): () => void;
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

function buildWebSocketUrl(): string {
	const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
	// We append a timestamp to the URL to bust the browser cache.
	// This is specifically required for mobile Safari, which can otherwise aggressively
	// cache the 101 Switching Protocols response and refuse to establish a new WebSocket
	// connection if the tab was suspended or encountered a momentary connection drop.
	const params = new URLSearchParams({ v: String(Date.now()) });
	return `${protocol}//${window.location.host}/ws?${params.toString()}`;
}

function generateRequestId() {
	return createRandomId();
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
	#stabilityTimeout: ReturnType<typeof setTimeout> | null = null;
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
	#heartbeatGeneration = 0;
	#lastInboundAt: number | null = null;
	#connectStartedAt: number | null = null;
	#messageConsumers = new Set<WsMessageConsumer>();
	#connectionListeners = new Set<WsConnectionListener>();
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
					this.#suspendHeartbeat();
					return;
				}
				if (this.isConnected) {
					this.#scheduleHeartbeat(HEARTBEAT_IMMEDIATE_PROBE_MS);
				} else {
					this.#connectNow('visibility-visible');
				}
			};
			this.#onlineHandler = () => {
				if (this.#destroyed) return;
				if (document.visibilityState === 'hidden') {
					this.#nextConnectReason = 'browser-online';
					return;
				}
				this.#connectNow('browser-online');
			};
			this.#offlineHandler = () => {
				if (!this.#destroyed) {
					this.#forceReconnect('browser-offline', { reconnectNow: false });
				}
			};
			document.addEventListener('visibilitychange', this.#visibilityHandler);
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
			const wsUrl = buildWebSocketUrl();
			const websocket = new WebSocket(wsUrl, webSocketProtocolsForAuth(token));
			this.#activeSocket = websocket;
			this.#connectStartedAt = Date.now();

			websocket.onopen = () => {
				if (!this.#isCurrentSocket(websocket)) return;
				const now = Date.now();
				this.#lastInboundAt = now;
				this.#connectStartedAt = null;
				this.#setConnected(true);
				this.#hasEverConnected = true;
				this.#ws = websocket;
				this.#setConnectionStatus({
					phase: 'connected',
					reason: null,
					reconnectAttempt: this.#reconnectAttempts,
					nextRetryAt: null,
					lastConnectedAt: now,
				});
				this.#resolveAllWaiters();
				this.#scheduleStabilityReset(websocket);
				this.#scheduleHeartbeat(this.#nextHeartbeatDelay());
			};

			websocket.onmessage = (event: MessageEvent) => {
				if (!this.#isCurrentSocket(websocket)) return;
				this.#lastInboundAt = Date.now();
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

					if (this.#consumeMessage(data)) return;

					this.#messageLog.push({ data, timestamp: Date.now() });
					this.#tryTrim();
					this.messageVersion++;
				} catch (error) {
					console.error('Error parsing WebSocket message:', error);
				}
			};

			websocket.onclose = (event) => {
				if (!this.#isCurrentSocket(websocket)) return;
				const now = Date.now();
				console.warn('WebSocket closed:', {
					code: event.code,
					reason: event.reason || null,
					wasClean: event.wasClean,
					extensions: websocket.extensions || null,
					bufferedAmount: websocket.bufferedAmount,
					lastInboundAgoMs: this.#lastInboundAt === null ? null : now - this.#lastInboundAt,
					visibilityState: document.visibilityState,
					online: navigator.onLine,
					connectedForMs:
						this.connectionStatus.lastConnectedAt === null
							? null
							: now - this.connectionStatus.lastConnectedAt,
				});
				const reason =
					this.connectionStatus.reason === 'socket-error' ? 'socket-error' : 'socket-close';
				this.#handleSocketClosed(reason);
			};

			websocket.onerror = () => {
				if (!this.#isCurrentSocket(websocket)) return;
				console.error('WebSocket error:', {
					readyState: websocket.readyState,
					extensions: websocket.extensions || null,
					bufferedAmount: websocket.bufferedAmount,
					visibilityState: document.visibilityState,
					online: navigator.onLine,
				});
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
		this.#clearStabilityTimeout();
		this.#suspendHeartbeat();
		this.#rejectAllWaiters('WebSocket destroyed');
		this.#rejectAllPending();
		this.#closeExisting({ rejectPending: false });
		this.#messageConsumers.clear();
		this.#connectionListeners.clear();
		if (this.#visibilityHandler) {
			document.removeEventListener('visibilitychange', this.#visibilityHandler);
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

	#setConnected(connected: boolean): void {
		if (this.isConnected === connected) return;
		this.isConnected = connected;
		for (const listener of [...this.#connectionListeners]) {
			try {
				listener(connected);
			} catch (error) {
				console.error('WebSocket connection listener failed:', error);
			}
		}
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
		this.#clearStabilityTimeout();
		this.#suspendHeartbeat();
		this.#setConnected(false);
		this.#ws = null;
		this.#activeSocket = null;
		this.#connectStartedAt = null;
		this.#lastInboundAt = null;
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

	addMessageConsumer(consumer: WsMessageConsumer): () => void {
		this.#messageConsumers.add(consumer);
		return () => this.#messageConsumers.delete(consumer);
	}

	onConnectionChange(listener: WsConnectionListener): () => void {
		this.#connectionListeners.add(listener);
		return () => this.#connectionListeners.delete(listener);
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
		this.#clearStabilityTimeout();
		this.#suspendHeartbeat();
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
			this.#connectStartedAt = null;
			this.#lastInboundAt = null;
			this.#setConnected(false);
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

	#consumeMessage(data: Record<string, unknown>): boolean {
		for (const consumer of [...this.#messageConsumers]) {
			try {
				if (consumer(data)) return true;
			} catch (error) {
				console.error('WebSocket message consumer failed:', error);
			}
		}
		return false;
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
		const generation = this.#heartbeatGeneration;
		this.#heartbeatInFlight = true;
		try {
			const raw = await this.sendRequest<Record<string, unknown>>(
				{
					type: 'ws-ping',
					sentAt: Date.now(),
				},
				HEARTBEAT_TIMEOUT_MS,
			);
			if (generation !== this.#heartbeatGeneration) return;
			if (raw.type !== 'ws-pong') throw new Error('Unexpected heartbeat response');
			this.#heartbeatInFlight = false;
			this.#scheduleHeartbeat(this.#nextHeartbeatDelay());
		} catch {
			if (generation !== this.#heartbeatGeneration) return;
			this.#heartbeatInFlight = false;
			if (this.#destroyed || !this.isConnected) return;
			if (
				this.#lastInboundAt !== null &&
				Date.now() - this.#lastInboundAt < HEARTBEAT_TIMEOUT_MS
			) {
				this.#scheduleHeartbeat(this.#nextHeartbeatDelay());
				return;
			}
			this.#forceReconnect('heartbeat-timeout', { reconnectNow: true });
		}
	}

	#forceReconnect(reason: WsConnectionIssue, options: { reconnectNow: boolean }): void {
		console.warn(`WebSocket reconnecting: ${reason}`);
		const episodeId = this.#beginOutage();
		this.#rejectAllPending();
		this.#closeExisting({ rejectPending: false });
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
		if (
			this.#activeSocket?.readyState === WebSocket.CONNECTING &&
			this.#connectStartedAt !== null &&
			Date.now() - this.#connectStartedAt < CONNECT_ATTEMPT_DEDUPE_MS
		) return;
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
		if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
			const currentPhase = this.connectionStatus.phase;
			const phase =
				currentPhase === 'offline' || currentPhase === 'failed' ? currentPhase : 'reconnecting';
			this.#setConnectionStatus({
				phase,
				reason,
				episodeId,
				nextRetryAt: null,
				lastDisconnectedAt: this.#lastDisconnectedAt,
			});
			return;
		}

		const delay = reconnectDelayMs(this.#reconnectAttempts);
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

	#scheduleStabilityReset(socket: WebSocket): void {
		this.#clearStabilityTimeout();
		this.#stabilityTimeout = setTimeout(() => {
			this.#stabilityTimeout = null;
			if (!this.#isCurrentSocket(socket) || socket.readyState !== WebSocket.OPEN) return;
			this.#reconnectAttempts = 0;
			this.#setConnectionStatus({ reconnectAttempt: 0 });
		}, CONNECTION_STABILITY_MS);
	}

	#clearStabilityTimeout(): void {
		if (this.#stabilityTimeout !== null) {
			clearTimeout(this.#stabilityTimeout);
			this.#stabilityTimeout = null;
		}
	}

	#clearHeartbeatTimer(): void {
		if (this.#heartbeatTimer !== null) {
			clearTimeout(this.#heartbeatTimer);
			this.#heartbeatTimer = null;
		}
	}

	#suspendHeartbeat(): void {
		this.#heartbeatGeneration += 1;
		this.#heartbeatInFlight = false;
		this.#clearHeartbeatTimer();
	}
}

export function createWsConnection(): WsConnection {
	return new WsConnection();
}
