import { LOCAL_EXECUTOR_ID } from '$shared/executors';
import type { UsageSummary, UsageWindowDays } from '$shared/usage';
import { getUsageSummary } from '$lib/api/usage.js';
import type { PortableSingletonController } from '$lib/workspace/portable-singleton-controller.js';
import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte.js';
import {
	buildUsageReport,
	type UsageMetric,
	type UsageModelTotals,
	type UsageReport,
} from './usage-report.js';
import {
	readUsagePreferences,
	saveUsagePreferences,
	type UsagePreferencesPersistence,
} from './usage-preferences.js';
import { usageWindow } from './usage-window.js';

export type UsageBreakdownKind = 'model' | 'day';

// A revealed surface rereads summaries older than this; transcripts keep growing while it is hidden.
const STALE_AFTER_MS = 5 * 60 * 1000;

export interface UsageControllerDeps {
	readonly read?: typeof getUsageSummary;
	readonly preferences?: UsagePreferencesPersistence;
	readonly now?: () => Date;
}

interface UsageRequest {
	readonly generation: number;
	readonly abort: AbortController;
}

/**
 * Owns the Usage surface: the selected executor, window, and metric, and the
 * summary read for them. Each read is fenced by generation, so a slow reply for
 * a previous selection never replaces a newer one, and the previous summary
 * stays visible, marked stale, while its replacement loads. A selected executor
 * that disappears stays selected and reports its unavailability; the surface never
 * falls back to Local on its own.
 */
export class UsageController implements PortableSingletonController {
	windowDays = $state<UsageWindowDays>(30);
	metric = $state<UsageMetric>('cost');
	breakdown = $state<UsageBreakdownKind>('model');
	executorId = $state<string>(LOCAL_EXECUTOR_ID);
	selectedModelKey = $state<string | null>(null);
	#summary = $state.raw<UsageSummary | null>(null);
	#error = $state<string | null>(null);
	#loading = $state(false);
	#readAtMs = 0;
	#visible = false;
	#generation = 0;
	#request: UsageRequest | null = null;
	readonly #report = $derived(this.#summary ? buildUsageReport(this.#summary) : null);
	readonly #read: typeof getUsageSummary;
	readonly #preferences: UsagePreferencesPersistence | undefined;
	readonly #now: () => Date;

	constructor(deps: UsageControllerDeps = {}) {
		this.#read = deps.read ?? getUsageSummary;
		this.#preferences = deps.preferences;
		this.#now = deps.now ?? (() => new Date());
		const preferences = readUsagePreferences(this.#preferences);
		this.windowDays = preferences.windowDays;
		this.metric = preferences.metric;
	}

	get summary(): UsageSummary | null {
		return this.#summary;
	}

	get report(): UsageReport | null {
		return this.#report;
	}

	get error(): string | null {
		return this.#error;
	}

	get loading(): boolean {
		return this.#loading;
	}

	/** Whether the shown summary belongs to a previous executor or window selection. */
	get stale(): boolean {
		const summary = this.#summary;
		if (!summary) return false;
		const window = usageWindow(this.windowDays, this.#now(), summary.timeZone);
		return (
			summary.executorId !== this.executorId ||
			summary.sinceDay !== window.sinceDay ||
			summary.untilDay !== window.untilDay
		);
	}

	get selectedModel(): UsageModelTotals | null {
		const key = this.selectedModelKey;
		if (key === null || this.stale) return null;
		return this.#report?.models.find((model) => model.key === key) ?? null;
	}

	setWindowDays(days: UsageWindowDays): void {
		if (this.windowDays === days) return;
		this.windowDays = days;
		this.#savePreferences();
		this.#refreshIfVisible();
	}

	setMetric(metric: UsageMetric): void {
		if (this.metric === metric) return;
		this.metric = metric;
		this.#savePreferences();
	}

	setBreakdown(breakdown: UsageBreakdownKind): void {
		this.breakdown = breakdown;
	}

	selectExecutor(executorId: string): void {
		if (this.executorId === executorId) return;
		this.executorId = executorId;
		this.selectedModelKey = null;
		this.#refreshIfVisible();
	}

	openModel(key: string): void {
		this.selectedModelKey = key;
	}

	closeModel(): void {
		this.selectedModelKey = null;
	}

	async refresh(): Promise<void> {
		const generation = ++this.#generation;
		this.#request?.abort.abort();
		const request: UsageRequest = { generation, abort: new AbortController() };
		this.#request = request;
		const executorId = this.executorId;
		const window = usageWindow(this.windowDays, this.#now());
		this.#loading = true;
		this.#error = null;
		try {
			const summary = await this.#read(executorId, window, request.abort.signal);
			if (generation !== this.#generation) return;
			this.#summary = summary;
			this.#readAtMs = this.#now().getTime();
		} catch (error) {
			if (generation !== this.#generation || request.abort.signal.aborted) return;
			this.#error = error instanceof Error ? error.message : String(error);
		} finally {
			if (generation === this.#generation) {
				this.#loading = false;
				this.#request = null;
			}
		}
	}

	setPresentationVisible(visible: boolean): void {
		this.#visible = visible;
		if (visible && !this.#loading && this.#needsRefresh()) void this.refresh();
	}

	setProjectState(projectState: WorkspaceProjectState): void {
		void projectState;
	}

	dispose(): void {
		this.#generation += 1;
		this.#request?.abort.abort();
		this.#request = null;
		this.#visible = false;
		this.#loading = false;
		this.#error = null;
		this.#summary = null;
		this.selectedModelKey = null;
	}

	// A hidden surface rereads when it is next revealed.
	#refreshIfVisible(): void {
		if (this.#visible) void this.refresh();
	}

	#needsRefresh(): boolean {
		return (
			this.#summary === null ||
			this.#error !== null ||
			this.stale ||
			this.#now().getTime() - this.#readAtMs > STALE_AFTER_MS
		);
	}

	#savePreferences(): void {
		saveUsagePreferences({ windowDays: this.windowDays, metric: this.metric }, this.#preferences);
	}
}
