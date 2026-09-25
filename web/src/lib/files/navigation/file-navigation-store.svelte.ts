import type { FileRevision } from '$shared/file-contracts';
import { effectiveExecutorId, parseExecutorId } from '$shared/executors';
import { fileIdentityKey } from '$lib/files/documents/file-identity.js';
import {
	FILE_RECENT_LIMIT,
	navigationKey,
	type FileDraftRepository,
	type FileRecentLocationV1,
} from '$lib/files/persistence/file-draft-repository.js';
export const FILE_NAVIGATION_LIMIT = 200;
export const FILE_NAVIGATION_BYTE_LIMIT = 256 * 1024;

export interface FileLocation {
	executorId?: string | null;
	key: string;
	canonicalFileRootPath: string;
	normalizedRelativePath: string;
	displayPath: string;
	revision: FileRevision | null;
	line: number;
	column: number;
	viewPreference: 'source' | 'preview' | 'image';
	timestamp: number;
}

export class FileNavigationStore {
	recents = $state.raw<readonly FileLocation[]>([]);
	#history = $state.raw<FileLocation[]>([]);
	#index = $state(-1);
	#pendingNavigation = $state.raw<{ previousIndex: number; targetKey: string } | null>(null);

	constructor(
		private readonly repository: FileDraftRepository,
		private readonly scope: { deploymentId: string; userNamespace: string },
	) {}

	get canGoBack(): boolean {
		return !this.#pendingNavigation && this.#index > 0;
	}

	get canGoForward(): boolean {
		return !this.#pendingNavigation && this.#index >= 0 && this.#index < this.#history.length - 1;
	}

	async restore(): Promise<void> {
		const [records, history] = await Promise.all([
			this.repository.getRecents(this.scope.userNamespace, this.scope.deploymentId),
			this.repository.getNavigation(this.scope.userNamespace, this.scope.deploymentId),
		]);
		const recents = new Map<string, FileLocation>();
		for (const record of records
			.filter(isValidRecentRecord)
			.sort((a, b) => b.timestamp - a.timestamp)) {
			const location = toLocation(record);
			if (!recents.has(location.key)) recents.set(location.key, location);
		}
		this.recents = pruneLocations(
			[...recents.values()],
			FILE_RECENT_LIMIT,
			FILE_NAVIGATION_BYTE_LIMIT,
		);
		if (history?.schemaVersion === 1) {
			this.#history = pruneLocations(
				history.entries.filter(isValidRecentRecord).map(toLocation),
				FILE_NAVIGATION_LIMIT,
				FILE_NAVIGATION_BYTE_LIMIT,
			);
			this.#index = Math.min(Math.max(history.index, -1), this.#history.length - 1);
		}
	}

	record(location: FileLocation): void {
		const recent = [location, ...this.recents.filter((item) => item.key !== location.key)];
		this.recents = pruneLocations(recent, FILE_RECENT_LIMIT, FILE_NAVIGATION_BYTE_LIMIT);
		if (this.#pendingNavigation?.targetKey === location.key) {
			this.#pendingNavigation = null;
		} else {
			this.#cancelPendingNavigation();
			this.#history = pruneNewestLocations(
				[...this.#history.slice(0, this.#index + 1), location],
				FILE_NAVIGATION_LIMIT,
				FILE_NAVIGATION_BYTE_LIMIT,
			);
			this.#index = this.#history.length - 1;
		}
		void Promise.all([
			this.repository.putRecent(this.#record(location)),
			this.#persistHistory(),
		]).catch(() => undefined);
	}

	back(): FileLocation | null {
		if (!this.canGoBack) return null;
		const previousIndex = this.#index;
		this.#index -= 1;
		this.#pendingNavigation = {
			previousIndex,
			targetKey: this.#history[this.#index]?.key ?? '',
		};
		void this.#persistHistory().catch(() => undefined);
		return this.#history[this.#index] ?? null;
	}

	forward(): FileLocation | null {
		if (!this.canGoForward) return null;
		const previousIndex = this.#index;
		this.#index += 1;
		this.#pendingNavigation = {
			previousIndex,
			targetKey: this.#history[this.#index]?.key ?? '',
		};
		void this.#persistHistory().catch(() => undefined);
		return this.#history[this.#index] ?? null;
	}

	completeNavigation(succeeded: boolean): void {
		if (!this.#pendingNavigation) return;
		if (!succeeded) this.#index = this.#pendingNavigation.previousIndex;
		this.#pendingNavigation = null;
		void this.#persistHistory().catch(() => undefined);
	}

	#record(location: FileLocation): FileRecentLocationV1 {
		return {
			schemaVersion: 1,
			deploymentId: this.scope.deploymentId,
			userNamespace: this.scope.userNamespace,
			...location,
		};
	}

	#persistHistory(): Promise<void> {
		return this.repository.putNavigation({
			schemaVersion: 1,
			deploymentId: this.scope.deploymentId,
			userNamespace: this.scope.userNamespace,
			key: navigationKey(this.scope.userNamespace, this.scope.deploymentId),
			entries: this.#history.map((location) => this.#record(location)),
			index: this.#index,
			updatedAt: Date.now(),
		});
	}

	#cancelPendingNavigation(): void {
		if (!this.#pendingNavigation) return;
		this.#index = this.#pendingNavigation.previousIndex;
		this.#pendingNavigation = null;
	}
}

function pruneLocations(
	locations: readonly FileLocation[],
	countLimit: number,
	byteLimit: number,
): FileLocation[] {
	const retained: FileLocation[] = [];
	let bytes = 0;
	for (const location of locations) {
		const nextBytes = new TextEncoder().encode(JSON.stringify(location)).byteLength;
		if (retained.length >= countLimit || bytes + nextBytes > byteLimit) break;
		retained.push(location);
		bytes += nextBytes;
	}
	return retained;
}

function pruneNewestLocations(
	locations: readonly FileLocation[],
	countLimit: number,
	byteLimit: number,
): FileLocation[] {
	return pruneLocations([...locations].reverse(), countLimit, byteLimit).reverse();
}

function isValidRecentRecord(record: FileRecentLocationV1): boolean {
	return (
		Boolean(parseExecutorId(record.executorId)) &&
		record.schemaVersion === 1 &&
		typeof record.key === 'string' &&
		typeof record.canonicalFileRootPath === 'string' &&
		typeof record.normalizedRelativePath === 'string'
	);
}

function toLocation(record: FileRecentLocationV1): FileLocation {
	const {
		schemaVersion: _schemaVersion,
		deploymentId: _deploymentId,
		userNamespace: _userNamespace,
		...location
	} = record;
	const executorId = effectiveExecutorId(record.executorId);
	return {
		...location,
		executorId,
		key: fileIdentityKey(record.canonicalFileRootPath, record.normalizedRelativePath, executorId),
	};
}
