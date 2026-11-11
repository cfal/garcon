import type { PresentationHostId } from './surface-types.js';

export const FRAME_REGISTRATION_TIMEOUT_MS = 5_000;

export interface FrameExpectation {
	surfaceId: string;
	host: PresentationHostId;
	generation: number;
	signal: AbortSignal;
}

export interface SurfaceFrameHandle {
	element: HTMLElement;
	attachRetainedRenderer: () => void | Promise<void>;
	focusPrimary: () => void;
}

interface FrameRegistration {
	surfaceId: string;
	handle: SurfaceFrameHandle;
	token: symbol;
	generation: number;
}

interface FrameWaiter {
	expectation: FrameExpectation;
	resolve: (handle: SurfaceFrameHandle) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	onAbort: () => void;
}

function frameKey(surfaceId: string, host: PresentationHostId): string {
	return JSON.stringify([surfaceId, host]);
}

export class SurfaceAttachmentError extends Error {
	constructor(
		readonly surfaceId: string,
		readonly host: PresentationHostId,
	) {
		super(`Timed out while attaching ${surfaceId} in ${host}`);
		this.name = 'SurfaceAttachmentError';
	}
}

export class SurfaceFrameRegistry {
	#nextGeneration = 0;
	#transfers = new Map<string, { generation: number; controller: AbortController }>();
	#registrations = new Map<string, FrameRegistration>();
	#waiters = new Map<string, FrameWaiter>();

	beginTransfer(surfaceId: string, host: PresentationHostId): FrameExpectation {
		this.cancel(surfaceId);
		const generation = ++this.#nextGeneration;
		const controller = new AbortController();
		this.#transfers.set(surfaceId, { generation, controller });
		return { surfaceId, host, generation, signal: controller.signal };
	}

	register(surfaceId: string, host: PresentationHostId, handle: SurfaceFrameHandle): () => void {
		const key = frameKey(surfaceId, host);
		const token = Symbol(key);
		const generation = this.#transfers.get(surfaceId)?.generation ?? 0;
		this.#registrations.set(key, { surfaceId, handle, token, generation });
		const waiter = this.#waiters.get(key);
		if (waiter && this.#isCurrent(waiter.expectation)) {
			this.#removeWaiter(key, waiter);
			waiter.resolve(handle);
		}
		return () => {
			if (this.#registrations.get(key)?.token === token) this.#registrations.delete(key);
		};
	}

	waitFor(expectation: FrameExpectation): Promise<SurfaceFrameHandle> {
		if (!this.#isCurrent(expectation)) return Promise.reject(this.#abortError());
		const key = frameKey(expectation.surfaceId, expectation.host);
		const registration = this.#registrations.get(key);
		if (registration?.generation === expectation.generation) {
			return Promise.resolve(registration.handle);
		}
		return new Promise((resolve, reject) => {
			const previous = this.#waiters.get(key);
			if (previous) {
				this.#removeWaiter(key, previous);
				previous.reject(this.#abortError());
			}
			const timer = setTimeout(() => {
				if (this.#waiters.get(key) !== waiter) return;
				this.#removeWaiter(key, waiter);
				reject(new SurfaceAttachmentError(expectation.surfaceId, expectation.host));
			}, FRAME_REGISTRATION_TIMEOUT_MS);
			const onAbort = () => {
				if (this.#waiters.get(key) !== waiter) return;
				this.#removeWaiter(key, waiter);
				reject(this.#abortError());
			};
			const waiter: FrameWaiter = { expectation, resolve, reject, timer, onAbort };
			this.#waiters.set(key, waiter);
			expectation.signal.addEventListener('abort', onAbort, { once: true });
		});
	}

	focus(surfaceId: string, host: PresentationHostId): boolean {
		const registration = this.#registrations.get(frameKey(surfaceId, host));
		if (!registration) return false;
		registration.handle.focusPrimary();
		return true;
	}

	cancel(surfaceId: string): void {
		this.#transfers.get(surfaceId)?.controller.abort();
		this.#transfers.delete(surfaceId);
		for (const [key, waiter] of this.#waiters) {
			if (waiter.expectation.surfaceId !== surfaceId) continue;
			this.#removeWaiter(key, waiter);
			waiter.reject(this.#abortError());
		}
	}

	release(surfaceId: string): void {
		this.cancel(surfaceId);
		for (const [key, registration] of this.#registrations) {
			if (registration.surfaceId === surfaceId) this.#registrations.delete(key);
		}
	}

	destroy(): void {
		for (const surfaceId of this.#transfers.keys()) this.cancel(surfaceId);
		this.#registrations.clear();
	}

	#removeWaiter(key: string, waiter: FrameWaiter): void {
		clearTimeout(waiter.timer);
		waiter.expectation.signal.removeEventListener('abort', waiter.onAbort);
		this.#waiters.delete(key);
	}

	#isCurrent(expectation: FrameExpectation): boolean {
		return (
			!expectation.signal.aborted &&
			this.#transfers.get(expectation.surfaceId)?.generation === expectation.generation
		);
	}

	#abortError(): Error {
		return new DOMException('Surface transfer was superseded', 'AbortError');
	}
}
