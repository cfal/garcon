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
	handle: SurfaceFrameHandle;
	token: symbol;
	generation: number;
}

interface FrameWaiter {
	expectation: FrameExpectation;
	resolve: (handle: SurfaceFrameHandle) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
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
	#generationBySurface = new Map<string, number>();
	#abortBySurface = new Map<string, AbortController>();
	#registrations = new Map<string, FrameRegistration>();
	#waiters = new Map<string, FrameWaiter>();

	beginTransfer(surfaceId: string, host: PresentationHostId): FrameExpectation {
		this.cancel(surfaceId);
		const generation = (this.#generationBySurface.get(surfaceId) ?? 0) + 1;
		const controller = new AbortController();
		this.#generationBySurface.set(surfaceId, generation);
		this.#abortBySurface.set(surfaceId, controller);
		return { surfaceId, host, generation, signal: controller.signal };
	}

	register(surfaceId: string, host: PresentationHostId, handle: SurfaceFrameHandle): () => void {
		const key = frameKey(surfaceId, host);
		const token = Symbol(key);
		const generation = this.#generationBySurface.get(surfaceId) ?? 0;
		this.#registrations.set(key, { handle, token, generation });
		const waiter = this.#waiters.get(key);
		if (waiter && this.#isCurrent(waiter.expectation)) {
			clearTimeout(waiter.timer);
			this.#waiters.delete(key);
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
			const timer = setTimeout(() => {
				this.#waiters.delete(key);
				reject(new SurfaceAttachmentError(expectation.surfaceId, expectation.host));
			}, FRAME_REGISTRATION_TIMEOUT_MS);
			const waiter: FrameWaiter = { expectation, resolve, reject, timer };
			this.#waiters.set(key, waiter);
			expectation.signal.addEventListener(
				'abort',
				() => {
					if (this.#waiters.get(key) !== waiter) return;
					clearTimeout(timer);
					this.#waiters.delete(key);
					reject(this.#abortError());
				},
				{ once: true },
			);
		});
	}

	focus(surfaceId: string, host: PresentationHostId): boolean {
		const registration = this.#registrations.get(frameKey(surfaceId, host));
		if (!registration) return false;
		registration.handle.focusPrimary();
		return true;
	}

	cancel(surfaceId: string): void {
		this.#abortBySurface.get(surfaceId)?.abort();
		this.#abortBySurface.delete(surfaceId);
		for (const [key, waiter] of this.#waiters) {
			if (waiter.expectation.surfaceId !== surfaceId) continue;
			clearTimeout(waiter.timer);
			this.#waiters.delete(key);
			waiter.reject(this.#abortError());
		}
	}

	destroy(): void {
		for (const surfaceId of this.#abortBySurface.keys()) this.cancel(surfaceId);
		this.#registrations.clear();
	}

	#isCurrent(expectation: FrameExpectation): boolean {
		return (
			!expectation.signal.aborted &&
			this.#generationBySurface.get(expectation.surfaceId) === expectation.generation
		);
	}

	#abortError(): Error {
		return new DOMException('Surface transfer was superseded', 'AbortError');
	}
}
