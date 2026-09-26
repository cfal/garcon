export interface GitMutationRequest<T> {
	executorId: string;
	surfaceId: string;
	effectiveProjectKey: string;
	projectPath: string;
	execute(): Promise<T>;
}

export interface GitMutationCoordinatorOptions {
	onChanged(executorId: string, effectiveProjectKey: string, projectPath: string): void | Promise<void>;
	onMutationError?(error: unknown, executorId: string, projectPath: string): void;
	onInvalidationError?(
		error: unknown,
		executorId: string,
		effectiveProjectKey: string,
		projectPath: string,
	): void;
}

export class GitMutationCoordinator {
	#pendingBySurface = $state<Record<string, number>>({});

	constructor(private readonly options: GitMutationCoordinatorOptions) {}

	pendingCount(surfaceId: string): number {
		return this.#pendingBySurface[surfaceId] ?? 0;
	}

	async run<T>(request: GitMutationRequest<T>): Promise<T> {
		this.#changePending(request.surfaceId, 1);
		let succeeded = false;
		try {
			const result = await request.execute();
			succeeded = true;
			return result;
		} catch (error) {
			this.options.onMutationError?.(error, request.executorId, request.projectPath);
			throw error;
		} finally {
			// Failed multi-command operations can still change refs or the index.
			try {
				const invalidation = this.#invalidate(request);
				if (succeeded) await invalidation;
			} finally {
				this.#changePending(request.surfaceId, -1);
			}
		}
	}

	async #invalidate(request: GitMutationRequest<unknown>): Promise<void> {
		try {
			await this.options.onChanged(
				request.executorId,
				request.effectiveProjectKey,
				request.projectPath,
			);
		} catch (error) {
			this.options.onInvalidationError?.(
				error,
				request.executorId,
				request.effectiveProjectKey,
				request.projectPath,
			);
		}
	}

	#changePending(surfaceId: string, delta: number): void {
		const next = Math.max(0, this.pendingCount(surfaceId) + delta);
		const { [surfaceId]: _previous, ...remaining } = this.#pendingBySurface;
		this.#pendingBySurface = next > 0 ? { ...remaining, [surfaceId]: next } : remaining;
	}
}
