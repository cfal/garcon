import { browseDirectory } from '$lib/api/files.js';

interface ProjectPathCompletionTarget {
	readonly nodeId: string;
	readonly filesAvailable: boolean;
	readonly pathContextKey?: string;
	projectPath: string;
	showBrowser: boolean;
}

export class ProjectPathCompletionController {
	#matches: string[] = [];
	#index = 0;
	#generation = 0;
	#contextKey: string | undefined;

	constructor(private readonly target: ProjectPathCompletionTarget) {}

	reset(): void {
		this.#matches = [];
		this.#index = 0;
		this.#generation += 1;
	}

	async complete(): Promise<void> {
		const { nodeId, projectPath: raw, filesAvailable, pathContextKey } = this.target;
		if (this.#contextKey !== pathContextKey) {
			this.reset();
			this.#contextKey = pathContextKey;
		}
		if (!filesAvailable || !raw) return;
		if (this.#matches.length > 1) {
			this.#index = (this.#index + 1) % this.#matches.length;
			this.target.projectPath = this.#matches[this.#index];
			return;
		}
		const generation = this.#generation;
		const lastSlash = raw.lastIndexOf('/');
		const parentDir = lastSlash >= 0 ? raw.slice(0, lastSlash) || '/' : '/';
		const partial = lastSlash >= 0 ? raw.slice(lastSlash + 1).toLowerCase() : '';

		try {
			const entries = await browseDirectory(parentDir, undefined, nodeId);
			if (
				this.#generation !== generation ||
				this.target.pathContextKey !== pathContextKey ||
				this.target.nodeId !== nodeId ||
				!this.target.filesAvailable ||
				this.target.projectPath !== raw
			)
				return;
			const matches = entries
				.filter((entry) => !partial || entry.name.toLowerCase().startsWith(partial))
				.map((entry) => entry.path);
			if (matches.length === 1) {
				this.target.projectPath = matches[0] + '/';
				this.#matches = [];
			} else if (matches.length > 1) {
				const common = longestCommonPrefix(matches);
				if (common.length > raw.length) this.target.projectPath = common;
				this.#matches = matches;
				this.#index = 0;
				this.target.showBrowser = true;
			}
		} catch {
			// Completion is best-effort; explicit path validation reports errors.
		}
	}
}

function longestCommonPrefix(strings: string[]): string {
	let prefix = strings[0];
	for (const value of strings.slice(1)) {
		while (!value.startsWith(prefix)) prefix = prefix.slice(0, -1);
	}
	return prefix;
}
