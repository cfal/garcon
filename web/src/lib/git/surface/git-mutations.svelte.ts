export interface GitMutationRequest<T> {
	nodeId: string;
	surfaceId: string;
	effectiveProjectKey: string;
	projectPath: string;
	execute(): Promise<T>;
}

export interface GitMutationCoordinatorOptions {
	onChanged(nodeId: string, effectiveProjectKey: string, projectPath: string): void | Promise<void>;
	onMutationError?(error: unknown, nodeId: string, projectPath: string): void;
	onInvalidationError?(
		error: unknown,
		nodeId: string,
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
		try {
			return await request.execute();
		} catch (error) {
			this.options.onMutationError?.(error, request.nodeId, request.projectPath);
			throw error;
		} finally {
			// Failed multi-command operations can still change refs or the index.
			try {
				await this.options.onChanged(
					request.nodeId,
					request.effectiveProjectKey,
					request.projectPath,
				);
			} catch (error) {
				this.options.onInvalidationError?.(
					error,
					request.nodeId,
					request.effectiveProjectKey,
					request.projectPath,
				);
			} finally {
				this.#changePending(request.surfaceId, -1);
			}
		}
	}

	#changePending(surfaceId: string, delta: number): void {
		const next = Math.max(0, this.pendingCount(surfaceId) + delta);
		const { [surfaceId]: _previous, ...remaining } = this.#pendingBySurface;
		this.#pendingBySurface = next > 0 ? { ...remaining, [surfaceId]: next } : remaining;
	}
}
