import type { GitComparisonSpecification } from './git-comparison.svelte.js';

export const GIT_COMPARISON_SESSION_LIMIT = 32;

export interface GitComparisonSessionIdentity {
	readonly chatId: string;
	readonly targetIdentity: string;
}

interface GitComparisonSessionEntry {
	readonly specification: GitComparisonSpecification;
}

export class GitComparisonSessionStore {
	readonly #entries = new Map<string, GitComparisonSessionEntry>();

	constructor(private readonly maxEntries = GIT_COMPARISON_SESSION_LIMIT) {}

	recall(identity: GitComparisonSessionIdentity): GitComparisonSpecification | null {
		const key = sessionKey(identity);
		const entry = this.#entries.get(key);
		if (!entry) return null;
		this.#entries.delete(key);
		this.#entries.set(key, entry);
		return cloneSpecification(entry.specification);
	}

	remember(
		identity: GitComparisonSessionIdentity,
		specification: GitComparisonSpecification,
	): void {
		const key = sessionKey(identity);
		this.#entries.delete(key);
		this.#entries.set(key, {
			specification: cloneSpecification(specification),
		});
		while (this.#entries.size > this.maxEntries) {
			const oldest = this.#entries.keys().next().value;
			if (oldest === undefined) break;
			this.#entries.delete(oldest);
		}
	}

	clear(): void {
		this.#entries.clear();
	}
}

function sessionKey(identity: GitComparisonSessionIdentity): string {
	return JSON.stringify([identity.chatId, identity.targetIdentity]);
}

function cloneSpecification(specification: GitComparisonSpecification): GitComparisonSpecification {
	return specification.toKind === 'working-tree'
		? {
				fromRevision: specification.fromRevision,
				toKind: 'working-tree',
				mode: 'direct',
			}
		: {
				fromRevision: specification.fromRevision,
				toKind: 'revision',
				toRevision: specification.toRevision,
				mode: specification.mode,
			};
}
