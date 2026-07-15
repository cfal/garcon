export interface GitMutationRequest<T> {
	surfaceId: string;
	effectiveProjectKey: string;
	projectPath: string;
	execute(): Promise<T>;
	didMutate?: (result: T) => boolean;
}

export interface GitMutationCoordinatorOptions {
	onChanged(effectiveProjectKey: string, projectPath: string): void | Promise<void>;
	onInvalidationError?(error: unknown, effectiveProjectKey: string, projectPath: string): void;
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
			const result = await request.execute();
			const didMutate = request.didMutate?.(result) ?? result !== false;
			if (didMutate) {
				try {
					await this.options.onChanged(request.effectiveProjectKey, request.projectPath);
				} catch (error) {
					this.options.onInvalidationError?.(
						error,
						request.effectiveProjectKey,
						request.projectPath,
					);
				}
			}
			return result;
		} finally {
			this.#changePending(request.surfaceId, -1);
		}
	}

	#changePending(surfaceId: string, delta: number): void {
		const next = Math.max(0, this.pendingCount(surfaceId) + delta);
		const { [surfaceId]: _previous, ...remaining } = this.#pendingBySurface;
		this.#pendingBySurface = next > 0 ? { ...remaining, [surfaceId]: next } : remaining;
	}
}
