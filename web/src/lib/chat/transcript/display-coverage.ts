export type CoverageMeasurement =
	| { kind: 'settled'; covered: boolean }
	| { kind: 'superseded' | 'waiting' };
export type CoverageOutcome = 'loaded' | 'exhausted' | 'blocked' | 'failed';
export interface DisplayCoveragePort {
	measure(): Promise<CoverageMeasurement>;
	load(): Promise<CoverageOutcome>;
	isVisible(): boolean;
}

/** Keeps measured demand alive across asynchronous loads and superseded layouts. */
export class DisplayCoverage {
	#revision = 0;
	#pending = false;
	#running = false;
	#disposed = false;
	#scheduled: ReturnType<typeof setTimeout> | null = null;
	status: 'needs-work' | 'running' | 'covered' | 'exhausted' | 'waiting' | 'failed' = 'needs-work';
	#counters = { wakeups: 0, requests: 0, superseded: 0, blocked: 0, failures: 0 };
	#underfilledSince: number | null = null;
	get metrics() { return { ...this.#counters, status: this.status,
		underfillMs: this.#underfilledSince === null ? 0 : performance.now() - this.#underfilledSince }; }

	constructor(private readonly port: DisplayCoveragePort) {}

	wake(): void {
		if (this.#disposed) return;
		this.#revision += 1;
		this.#counters.wakeups++;
		this.#pending = true;
		this.#schedule();
	}

	#schedule(): void {
		if (this.#disposed || this.#running || this.#scheduled !== null || !this.#pending) return;
		this.#scheduled = setTimeout(() => {
			this.#scheduled = null;
			void this.#run();
		}, 0);
	}

	async #run(): Promise<void> {
		if (this.#disposed || !this.port.isVisible()) { this.status = 'waiting'; return; }
		const revision = this.#revision;
		this.#running = true;
		this.#pending = false;
		this.status = 'running';
		try {
			const measured = await this.port.measure();
			if (this.#disposed) return;
			if (measured.kind !== 'settled') {
				this.status = 'waiting';
				if (measured.kind === 'superseded') { this.#pending = true; this.#counters.superseded++; }
			} else if (measured.covered) { this.status = 'covered'; this.#underfilledSince = null; }
			else {
				this.#underfilledSince ??= performance.now();
				this.#counters.requests++;
				const outcome = await this.port.load();
				if (this.#disposed) return;
				switch (outcome) {
					case 'loaded':
						this.status = 'needs-work';
						this.#pending = true;
						break;
					case 'blocked':
						this.status = 'waiting';
						this.#counters.blocked++;
						break;
					case 'exhausted':
					case 'failed':
						this.status = outcome;
						this.#underfilledSince = null;
						if (outcome === 'failed') this.#counters.failures++;
						break;
				}
			}
		} catch {
			this.status = 'failed';
			this.#counters.failures++;
		} finally {
			this.#running = false;
			this.#pending ||= revision !== this.#revision;
			this.#schedule();
		}
	}

	dispose(): void {
		this.#disposed = true;
		if (this.#scheduled !== null) clearTimeout(this.#scheduled);
		this.#scheduled = null;
	}
}
