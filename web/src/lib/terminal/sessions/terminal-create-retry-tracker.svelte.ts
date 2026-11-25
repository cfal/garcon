export const TERMINAL_CREATE_RETRY_WINDOW_MS = 10 * 60 * 1000;

interface PendingTerminalCreate {
	executorId: string;
	terminalRuntimeId?: string;
	requestId: string;
	requestedInitialWorkingDirectory: string | null;
	startedAt: number;
	requiresList: boolean;
}

export class TerminalCreateRetryTracker {
	attempts = $state.raw<Readonly<Record<string, PendingTerminalCreate>>>({});
	readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(
		private readonly now: () => number,
		private readonly reconcile: () => void,
	) {}

	start(attempt: Omit<PendingTerminalCreate, 'startedAt' | 'requiresList'>): PendingTerminalCreate {
		const pending = { ...attempt, startedAt: this.now(), requiresList: false };
		const { requestId } = pending;
		this.attempts = { ...this.attempts, [requestId]: pending };
		this.#timers.set(
			requestId,
			setTimeout(() => {
				this.requireList(pending);
				this.reconcile();
			}, TERMINAL_CREATE_RETRY_WINDOW_MS),
		);
		return pending;
	}

	expired(attempt: PendingTerminalCreate): boolean {
		return this.now() - attempt.startedAt >= TERMINAL_CREATE_RETRY_WINDOW_MS;
	}

	requireList(attempt: PendingTerminalCreate): void {
		this.#cancelTimer(attempt.requestId);
		if (!attempt.requiresList) {
			this.attempts = { ...this.attempts, [attempt.requestId]: { ...attempt, requiresList: true } };
		}
	}

	clear(requestId: string): void {
		this.#cancelTimer(requestId);
		const { [requestId]: _removed, ...remaining } = this.attempts;
		this.attempts = remaining;
	}

	reconciled(executorId: string): void {
		for (const attempt of Object.values(this.attempts))
			if (attempt.executorId === executorId && attempt.requiresList) this.clear(attempt.requestId);
	}

	removeExecutor(executorId: string): void {
		for (const attempt of Object.values(this.attempts))
			if (attempt.executorId === executorId) this.clear(attempt.requestId);
	}

	destroy(): void {
		for (const requestId of this.#timers.keys()) this.#cancelTimer(requestId);
		this.attempts = {};
	}

	#cancelTimer(requestId: string): void {
		clearTimeout(this.#timers.get(requestId));
		this.#timers.delete(requestId);
	}
}
