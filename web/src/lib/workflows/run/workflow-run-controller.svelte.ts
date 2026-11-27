import type { getWorkflowRun } from '$lib/api/workflows';
import type { WorkflowRunDetail } from '$shared/workflow-runs';
import { isUnconfirmedWorkflowMutation } from '../workflow-mutation';
import { workflowRunFinished } from './workflow-run-projection';

const POLL_INTERVAL_MS = 2_500;
const FAILURE_INTERVAL_MS = 10_000;

type Mutation = () => Promise<WorkflowRunDetail>;

export class WorkflowRunController {
	detail = $state.raw<WorkflowRunDetail | null>(null);
	readError = $state<unknown>(null);
	actionError = $state<unknown>(null);
	mutating = $state(false);
	#active = false;
	#disposed = false;
	#read: AbortController | null = null;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#unconfirmed = $state.raw<Mutation | null>(null);
	get actionUnconfirmed(): boolean {
		return this.#unconfirmed !== null;
	}

	constructor(
		readonly runId: string,
		private readonly getRun: typeof getWorkflowRun,
	) {}

	observe(): () => void {
		this.#active = true;
		void this.refresh();
		return () => {
			this.#active = false;
			this.#cancelRead();
		};
	}

	#cancelRead(): void {
		clearTimeout(this.#timer);
		this.#read?.abort();
		this.#read = null;
	}

	#schedule(delay = POLL_INTERVAL_MS): void {
		if (!this.#active || this.#disposed || (this.detail && workflowRunFinished(this.detail)))
			return;
		this.#timer = setTimeout(() => void this.refresh(), delay);
	}

	async refresh(): Promise<void> {
		if (!this.#active || this.#disposed || this.#read || this.mutating) return;
		clearTimeout(this.#timer);
		const request = new AbortController();
		this.#read = request;
		try {
			const result = await this.getRun(this.runId, { signal: request.signal });
			if (this.#read !== request) return;
			this.detail = result;
			this.readError = null;
		} catch (error) {
			if (this.#read === request) this.readError = error;
		} finally {
			if (this.#read === request) {
				this.#read = null;
				this.#schedule(this.readError ? FAILURE_INTERVAL_MS : POLL_INTERVAL_MS);
			}
		}
	}

	async mutate(action: Mutation): Promise<boolean> {
		if (this.#unconfirmed || !this.#active || this.#disposed || this.mutating) return false;
		return this.#perform(action);
	}

	async retryUnconfirmed(): Promise<boolean> {
		if (!this.#unconfirmed || !this.#active || this.#disposed || this.mutating) return false;
		return this.#perform(this.#unconfirmed);
	}

	async #perform(action: Mutation): Promise<boolean> {
		this.#cancelRead();
		this.mutating = true;
		this.actionError = null;
		try {
			const result = await action();
			if (this.#disposed) return false;
			this.detail = result;
			this.readError = null;
			this.#unconfirmed = null;
			return true;
		} catch (error) {
			if (this.#disposed) return false;
			this.actionError = error;
			this.#unconfirmed = isUnconfirmedWorkflowMutation(error) ? action : null;
			return false;
		} finally {
			if (!this.#disposed) {
				this.mutating = false;
				this.#schedule();
			}
		}
	}

	dispose(): void {
		this.#disposed = true;
		this.#cancelRead();
	}
}
