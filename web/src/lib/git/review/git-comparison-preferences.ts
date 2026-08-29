import type { GitComparisonSpecification } from './git-comparison.svelte.js';
import {
	getLocalStorageItem,
	LOCAL_STORAGE_KEYS,
	setLocalStorageItem,
} from '$lib/utils/local-persistence.js';
import { projectPathAndAncestors } from '$lib/utils/project-path.js';

const LEGACY_SCHEMA_VERSION = 1;
const SCHEMA_VERSION = 2;
export const GIT_COMPARISON_CHAT_PREFERENCE_LIMIT = 20;
export const GIT_COMPARISON_PROJECT_PREFERENCE_LIMIT = 20;

export interface GitComparisonPreferenceContext {
	chatId: string;
	projectPath: string;
}

export interface GitComparisonPreferences {
	recall(context: GitComparisonPreferenceContext): GitComparisonSpecification | null;
	rememberChat(chatId: string, specification: GitComparisonSpecification): void;
	rememberUserSelection(
		context: GitComparisonPreferenceContext,
		specification: GitComparisonSpecification,
	): void;
}

export interface GitComparisonPreferencePersistence {
	read(): string | null;
	write(value: string): void;
}

interface GitComparisonPreferenceEntry {
	chatId: string;
	specification: GitComparisonSpecification;
}

interface GitComparisonProjectPreferenceEntry {
	projectPath: string;
	specification: GitComparisonSpecification;
}

interface GitComparisonPreferenceRecord {
	version: typeof SCHEMA_VERSION;
	entries: GitComparisonPreferenceEntry[];
	projectEntries: GitComparisonProjectPreferenceEntry[];
}

const browserPersistence: GitComparisonPreferencePersistence = {
	read: () => getLocalStorageItem(LOCAL_STORAGE_KEYS.gitComparisonPreferences),
	write: (value) => setLocalStorageItem(LOCAL_STORAGE_KEYS.gitComparisonPreferences, value),
};

export class LocalGitComparisonPreferences implements GitComparisonPreferences {
	constructor(
		private readonly persistence: GitComparisonPreferencePersistence = browserPersistence,
	) {}

	recall(context: GitComparisonPreferenceContext): GitComparisonSpecification | null {
		const record = this.#readRecord();
		if (isNonEmptyString(context.chatId)) {
			const chatIndex = record.entries.findIndex((entry) => entry.chatId === context.chatId);
			const chatEntry = record.entries[chatIndex];
			if (chatEntry) {
				if (chatIndex > 0) {
					record.entries = touchEntry(record.entries, chatIndex);
					this.#writeRecord(record);
				}
				return cloneSpecification(chatEntry.specification);
			}
		}

		for (const projectPath of projectPathAndAncestors(context.projectPath)) {
			const projectIndex = record.projectEntries.findIndex(
				(entry) => entry.projectPath === projectPath,
			);
			const projectEntry = record.projectEntries[projectIndex];
			if (!projectEntry) continue;
			if (projectIndex > 0) {
				record.projectEntries = touchEntry(record.projectEntries, projectIndex);
				this.#writeRecord(record);
			}
			return cloneSpecification(projectEntry.specification);
		}
		return null;
	}

	rememberChat(chatId: string, specification: GitComparisonSpecification): void {
		if (!isNonEmptyString(chatId)) return;
		const record = this.#readRecord();
		this.#rememberChatEntry(record, chatId, specification);
		this.#writeRecord(record);
	}

	rememberUserSelection(
		context: GitComparisonPreferenceContext,
		specification: GitComparisonSpecification,
	): void {
		if (!isNonEmptyString(context.chatId)) return;
		const record = this.#readRecord();
		this.#rememberChatEntry(record, context.chatId, specification);
		const [projectPath] = projectPathAndAncestors(context.projectPath);
		if (projectPath) {
			record.projectEntries = rememberEntry(
				record.projectEntries,
				(entry) => entry.projectPath === projectPath,
				{ projectPath, specification: cloneSpecification(specification) },
				GIT_COMPARISON_PROJECT_PREFERENCE_LIMIT,
			);
		}
		this.#writeRecord(record);
	}

	#rememberChatEntry(
		record: GitComparisonPreferenceRecord,
		chatId: string,
		specification: GitComparisonSpecification,
	): void {
		record.entries = rememberEntry(
			record.entries,
			(entry) => entry.chatId === chatId,
			{ chatId, specification: cloneSpecification(specification) },
			GIT_COMPARISON_CHAT_PREFERENCE_LIMIT,
		);
	}

	#readRecord(): GitComparisonPreferenceRecord {
		try {
			const raw = this.persistence.read();
			if (!raw) return emptyRecord();
			return parseRecord(JSON.parse(raw));
		} catch {
			return emptyRecord();
		}
	}

	#writeRecord(record: GitComparisonPreferenceRecord): void {
		const persistedRecord: GitComparisonPreferenceRecord = {
			version: SCHEMA_VERSION,
			entries: record.entries.slice(0, GIT_COMPARISON_CHAT_PREFERENCE_LIMIT),
			projectEntries: record.projectEntries.slice(0, GIT_COMPARISON_PROJECT_PREFERENCE_LIMIT),
		};
		try {
			this.persistence.write(JSON.stringify(persistedRecord));
		} catch {
			// Comparison loading remains available when browser storage is unavailable.
		}
	}
}

function emptyRecord(): GitComparisonPreferenceRecord {
	return { version: SCHEMA_VERSION, entries: [], projectEntries: [] };
}

function parseRecord(value: unknown): GitComparisonPreferenceRecord {
	if (
		!isRecord(value) ||
		(value.version !== LEGACY_SCHEMA_VERSION && value.version !== SCHEMA_VERSION) ||
		!Array.isArray(value.entries)
	) {
		return emptyRecord();
	}
	return {
		version: SCHEMA_VERSION,
		entries: parseChatEntries(value.entries),
		projectEntries:
			value.version === SCHEMA_VERSION && Array.isArray(value.projectEntries)
				? parseProjectEntries(value.projectEntries)
				: [],
	};
}

function parseChatEntries(values: unknown[]): GitComparisonPreferenceEntry[] {
	const entries: GitComparisonPreferenceEntry[] = [];
	const seenChatIds = new Set<string>();
	for (const valueEntry of values) {
		if (entries.length >= GIT_COMPARISON_CHAT_PREFERENCE_LIMIT) break;
		if (!isRecord(valueEntry) || !isNonEmptyString(valueEntry.chatId)) continue;
		if (seenChatIds.has(valueEntry.chatId)) continue;
		const specification = parseSpecification(valueEntry.specification);
		if (!specification) continue;
		seenChatIds.add(valueEntry.chatId);
		entries.push({ chatId: valueEntry.chatId, specification });
	}
	return entries;
}

function parseProjectEntries(values: unknown[]): GitComparisonProjectPreferenceEntry[] {
	const entries: GitComparisonProjectPreferenceEntry[] = [];
	const seenProjectPaths = new Set<string>();
	for (const valueEntry of values) {
		if (entries.length >= GIT_COMPARISON_PROJECT_PREFERENCE_LIMIT) break;
		if (!isRecord(valueEntry) || !isNonEmptyString(valueEntry.projectPath)) continue;
		const [projectPath] = projectPathAndAncestors(valueEntry.projectPath);
		if (!projectPath || seenProjectPaths.has(projectPath)) continue;
		const specification = parseSpecification(valueEntry.specification);
		if (!specification) continue;
		seenProjectPaths.add(projectPath);
		entries.push({ projectPath, specification });
	}
	return entries;
}

function touchEntry<T>(entries: T[], index: number): T[] {
	const entry = entries[index];
	return entry ? [entry, ...entries.slice(0, index), ...entries.slice(index + 1)] : entries;
}

function rememberEntry<T>(
	entries: T[],
	matches: (entry: T) => boolean,
	entry: T,
	limit: number,
): T[] {
	return [entry, ...entries.filter((candidate) => !matches(candidate))].slice(0, limit);
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
