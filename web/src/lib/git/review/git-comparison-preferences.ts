import type { GitComparisonSpecification } from './git-comparison.svelte.js';
import {
	getLocalStorageItem,
	LOCAL_STORAGE_KEYS,
	setLocalStorageItem,
} from '$lib/utils/local-persistence.js';

const SCHEMA_VERSION = 1;
export const GIT_COMPARISON_PREFERENCE_LIMIT = 20;

export interface GitComparisonPreferences {
	recall(chatId: string): GitComparisonSpecification | null;
	remember(chatId: string, specification: GitComparisonSpecification): void;
}

export interface GitComparisonPreferencePersistence {
	read(): string | null;
	write(value: string): void;
}

interface GitComparisonPreferenceEntry {
	chatId: string;
	specification: GitComparisonSpecification;
}

interface GitComparisonPreferenceRecord {
	version: typeof SCHEMA_VERSION;
	entries: GitComparisonPreferenceEntry[];
}

const browserPersistence: GitComparisonPreferencePersistence = {
	read: () => getLocalStorageItem(LOCAL_STORAGE_KEYS.gitComparisonPreferences),
	write: (value) => setLocalStorageItem(LOCAL_STORAGE_KEYS.gitComparisonPreferences, value),
};

export class LocalGitComparisonPreferences implements GitComparisonPreferences {
	constructor(
		private readonly persistence: GitComparisonPreferencePersistence = browserPersistence,
	) {}

	recall(chatId: string): GitComparisonSpecification | null {
		if (!isNonEmptyString(chatId)) return null;
		const entries = this.#readEntries();
		const index = entries.findIndex((entry) => entry.chatId === chatId);
		if (index < 0) return null;

		const [entry] = entries.splice(index, 1);
		if (!entry) return null;
		if (index > 0) this.#writeEntries([entry, ...entries]);
		return cloneSpecification(entry.specification);
	}

	remember(chatId: string, specification: GitComparisonSpecification): void {
		if (!isNonEmptyString(chatId)) return;
		const entries = this.#readEntries().filter((entry) => entry.chatId !== chatId);
		this.#writeEntries([{ chatId, specification: cloneSpecification(specification) }, ...entries]);
	}

	#readEntries(): GitComparisonPreferenceEntry[] {
		try {
			const raw = this.persistence.read();
			if (!raw) return [];
			return parseRecord(JSON.parse(raw));
		} catch {
			return [];
		}
	}

	#writeEntries(entries: GitComparisonPreferenceEntry[]): void {
		const record: GitComparisonPreferenceRecord = {
			version: SCHEMA_VERSION,
			entries: entries.slice(0, GIT_COMPARISON_PREFERENCE_LIMIT),
		};
		try {
			this.persistence.write(JSON.stringify(record));
		} catch {
			// Comparison loading remains available when browser storage is unavailable.
		}
	}
}

function parseRecord(value: unknown): GitComparisonPreferenceEntry[] {
	if (!isRecord(value) || value.version !== SCHEMA_VERSION || !Array.isArray(value.entries)) {
		return [];
	}

	const entries: GitComparisonPreferenceEntry[] = [];
	const seenChatIds = new Set<string>();
	for (const valueEntry of value.entries) {
		if (entries.length >= GIT_COMPARISON_PREFERENCE_LIMIT) break;
		if (!isRecord(valueEntry) || !isNonEmptyString(valueEntry.chatId)) continue;
		if (seenChatIds.has(valueEntry.chatId)) continue;
		const specification = parseSpecification(valueEntry.specification);
		if (!specification) continue;
		seenChatIds.add(valueEntry.chatId);
		entries.push({ chatId: valueEntry.chatId, specification });
	}
	return entries;
}

function parseSpecification(value: unknown): GitComparisonSpecification | null {
	if (!isRecord(value) || !isNonEmptyString(value.fromRevision)) return null;
	if (value.toKind === 'working-tree') {
		if (value.mode !== 'direct') return null;
		return {
			fromRevision: value.fromRevision,
			toKind: 'working-tree',
			mode: 'direct',
		};
	}
	if (
		value.toKind !== 'revision' ||
		!isNonEmptyString(value.toRevision) ||
		(value.mode !== 'direct' && value.mode !== 'merge-base')
	) {
		return null;
	}
	return {
		fromRevision: value.fromRevision,
		toKind: 'revision',
		toRevision: value.toRevision,
		mode: value.mode,
	};
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}
