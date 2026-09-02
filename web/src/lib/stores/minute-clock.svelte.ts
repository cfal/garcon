// App-wide minute-aligned clock for surfaces that render relative timestamps
// or bucket chats by recency, so they refresh and classify on the same tick.

const MINUTE_MS = 60_000;

function msUntilNextMinute(nowMs = Date.now()): number {
	const elapsedInMinute = nowMs % MINUTE_MS;
	return elapsedInMinute === 0 ? MINUTE_MS : MINUTE_MS - elapsedInMinute;
}

export class MinuteClockStore {
	currentTime = $state(new Date());

	#timeoutId: ReturnType<typeof setTimeout> | null = null;
	#intervalId: ReturnType<typeof setInterval> | null = null;
	#visibilityListener = () => {
		if (document.visibilityState === 'visible') this.#refresh();
	};

	constructor() {
		if (typeof window === 'undefined') return;
		this.#timeoutId = setTimeout(() => {
			this.#refresh();
			this.#intervalId = setInterval(() => this.#refresh(), MINUTE_MS);
		}, msUntilNextMinute());
		document.addEventListener('visibilitychange', this.#visibilityListener);
	}

	destroy(): void {
		if (this.#timeoutId !== null) clearTimeout(this.#timeoutId);
		if (this.#intervalId !== null) clearInterval(this.#intervalId);
		this.#timeoutId = null;
		this.#intervalId = null;
		if (typeof window !== 'undefined') {
			document.removeEventListener('visibilitychange', this.#visibilityListener);
		}
	}

	#refresh(): void {
		this.currentTime = new Date();
	}
}

export function createMinuteClockStore(): MinuteClockStore {
	return new MinuteClockStore();
}
