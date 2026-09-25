import * as api from '$lib/api/executors.js';
import type { ExecutorsStore } from '$lib/executors/executors-store.svelte.js';
import type { ExecutorDirection, ExecutorSnapshot } from '$shared/executors';

export class ExecutorEditor {
	id = $state<string | null>(null);
	label = $state('');
	direction = $state<ExecutorDirection>('executor-connects');
	connectionUrl = $state('');
	allowInsecureDevelopment = $state(false);
	allowUnverifiedTls = $state(false);
	enabled = $state(true);
	allowControllerCli = $state(false);
	busy = $state(false);
	error = $state<string | null>(null);
	confirmDelete = $state(false);
	#version = 0;
	#originalUrl = '';
	#originalDirection: ExecutorDirection = 'executor-connects';
	#originalInsecure = false;
	#originalUnverifiedTls = false;
	#originalEnabled = true;
	#originalControllerCli = false;

	constructor(private readonly executors: ExecutorsStore, private readonly transport = api) {}

	get withoutTls(): boolean {
		try { return new URL(this.connectionUrl.trim()).protocol === 'ws:'; }
		catch { return false; }
	}

	clear(): void {
		this.#version += 1;
		this.id = null;
		this.label = '';
		this.direction = 'executor-connects';
		this.connectionUrl = '';
		this.#originalUrl = '';
		this.allowInsecureDevelopment = false;
		this.allowUnverifiedTls = false;
		this.enabled = true;
		this.allowControllerCli = false;
		this.busy = false;
		this.error = null;
		this.confirmDelete = false;
	}

	async edit(executor: ExecutorSnapshot): Promise<void> {
		this.clear();
		this.id = executor.id;
		this.label = executor.label;
		this.direction = executor.direction ?? 'executor-connects';
		this.enabled = this.#originalEnabled = executor.enabled;
		this.allowControllerCli = this.#originalControllerCli = executor.allowControllerCli;
		const version = this.#version;
		this.busy = true;
		try {
			const connection = await this.transport.getExecutorConnection(executor.id);
			if (version !== this.#version) return;
			this.connectionUrl = this.#originalUrl = connection.connectionUrl;
			this.#originalDirection = this.direction;
			this.allowInsecureDevelopment = this.#originalInsecure = connection.allowInsecureDevelopment;
			this.allowUnverifiedTls = this.#originalUnverifiedTls = connection.allowUnverifiedTls;
		} catch (error) {
			if (version === this.#version) this.error = error instanceof Error ? error.message : 'Unable to load connection';
		} finally {
			if (version === this.#version) this.busy = false;
		}
	}

	async save(): Promise<boolean> {
		if (this.busy) return false;
		this.busy = true;
		this.error = null;
		const version = this.#version;
		const previousExecutors = this.executors.executors;
		const allowUnverifiedTls = this.direction === 'controller-connects' && !this.withoutTls && this.allowUnverifiedTls;
		try {
			if (this.id) {
				const connectionChanged = this.connectionUrl !== this.#originalUrl || this.direction !== this.#originalDirection
					|| this.allowInsecureDevelopment !== this.#originalInsecure || allowUnverifiedTls !== this.#originalUnverifiedTls;
				const executors = await this.transport.updateExecutor(this.id, {
					label: this.label.trim(),
					...(this.enabled !== this.#originalEnabled ? { enabled: this.enabled } : {}),
					...(this.allowControllerCli !== this.#originalControllerCli ? { allowControllerCli: this.allowControllerCli } : {}),
					...(connectionChanged ? { connection: { direction: this.direction, connectionUrl: this.connectionUrl.trim(), allowInsecureDevelopment: this.allowInsecureDevelopment, allowUnverifiedTls } } : {}),
				});
				if (this.executors.executors === previousExecutors) this.executors.applySnapshot(executors);
				else await this.executors.refreshAfterMutation();
				if (version !== this.#version) return false;
			} else {
				const result = await this.transport.createExecutor({
					label: this.label.trim(), allowInsecureDevelopment: this.allowInsecureDevelopment, allowUnverifiedTls,
					allowControllerCli: this.allowControllerCli,
					...(this.direction === 'executor-connects' ? { direction: 'executor-connects' } : { direction: 'controller-connects', connectionUrl: this.connectionUrl.trim() }),
				});
				await this.executors.refreshAfterMutation();
				if (version !== this.#version) return false;
				this.id = result.id;
				this.connectionUrl = result.connectionUrl;
				this.allowInsecureDevelopment = result.allowInsecureDevelopment;
			}
			this.#originalUrl = this.connectionUrl;
			this.#originalDirection = this.direction;
			this.#originalInsecure = this.allowInsecureDevelopment;
			this.allowUnverifiedTls = this.#originalUnverifiedTls = allowUnverifiedTls;
			this.#originalEnabled = this.enabled;
			this.#originalControllerCli = this.allowControllerCli;
			return true;
		} catch (error) {
			if (version === this.#version) this.error = error instanceof Error ? error.message : 'Unable to save executor';
			return false;
		} finally {
			if (version === this.#version) this.busy = false;
		}
	}

	async remove(): Promise<boolean> {
		if (!this.id || this.busy || !this.confirmDelete) return false;
		this.busy = true;
		const version = this.#version;
		const previousExecutors = this.executors.executors;
		try {
			const executors = await this.transport.removeExecutor(this.id);
			if (this.executors.executors === previousExecutors) this.executors.applySnapshot(executors);
			else await this.executors.refreshAfterMutation();
			if (version !== this.#version) return false;
			this.clear();
			return true;
		} catch (error) {
			if (version === this.#version) this.error = error instanceof Error ? error.message : 'Unable to remove executor';
			return false;
		} finally {
			if (version === this.#version) this.busy = false;
		}
	}
}
