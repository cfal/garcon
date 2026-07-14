import {
	CHAT_SURFACE_ID,
	DEFAULT_RIGHT_SIDEBAR_WIDTH,
	MAX_MOBILE_RETURN_TARGETS,
	type ActiveSurfaceKind,
	type HostState,
	type MobileReturnTarget,
	type SurfaceDescriptor,
	type WorkspaceLayoutCommitPort,
	type WorkspaceLayoutMutation,
	type WorkspaceLayoutReader,
	type WorkspaceLayoutSnapshot,
	isPortableSingleton,
	terminalSurfaceId,
} from '$lib/workspace/surface-types';
import { clampDesiredSidebarWidth } from '$lib/workspace/sidebar-sizing';

const DEFAULT_SURFACES: Readonly<Record<string, SurfaceDescriptor>> = {
	[CHAT_SURFACE_ID]: { id: CHAT_SURFACE_ID, type: 'singleton', kind: 'chat' },
	'singleton:git': { id: 'singleton:git', type: 'singleton', kind: 'git' },
	'singleton:pull-requests': {
		id: 'singleton:pull-requests',
		type: 'singleton',
		kind: 'pull-requests',
	},
	'singleton:files': { id: 'singleton:files', type: 'singleton', kind: 'files' },
	'singleton:commit': {
		id: 'singleton:commit',
		type: 'singleton',
		kind: 'commit',
	},
};

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function hostWithOrder(host: HostState, order: readonly string[]): HostState {
	const nextOrder = unique(order);
	const nextMru = unique(host.mru).filter((id) => nextOrder.includes(id));
	for (const id of nextOrder) {
		if (!nextMru.includes(id)) nextMru.push(id);
	}
	const activeId =
		host.activeId && nextOrder.includes(host.activeId)
			? host.activeId
			: (nextMru[0] ?? nextOrder[0] ?? null);
	return { order: nextOrder, activeId, mru: nextMru };
}

function activateHost(host: HostState, surfaceId: string): HostState {
	if (!host.order.includes(surfaceId)) throw new Error(`Surface is not in host: ${surfaceId}`);
	return {
		order: [...host.order],
		activeId: surfaceId,
		mru: [surfaceId, ...host.mru.filter((id) => id !== surfaceId)],
	};
}

function insertIntoHost(host: HostState, surfaceId: string, index?: number): HostState {
	const without = host.order.filter((id) => id !== surfaceId);
	const insertionIndex =
		index === undefined ? without.length : Math.max(0, Math.min(without.length, Math.trunc(index)));
	without.splice(insertionIndex, 0, surfaceId);
	return hostWithOrder(
		{ ...host, mru: [surfaceId, ...host.mru.filter((id) => id !== surfaceId)] },
		without,
	);
}

function removeFromHost(host: HostState, surfaceId: string): HostState {
	return hostWithOrder(
		{ ...host, mru: host.mru.filter((id) => id !== surfaceId) },
		host.order.filter((id) => id !== surfaceId),
	);
}

function normalizeReturnStack(stack: readonly MobileReturnTarget[]): MobileReturnTarget[] {
	const normalized: MobileReturnTarget[] = [];
	for (const target of stack) {
		if (!target || typeof target.invokerSurfaceId !== 'string' || !target.invokerSurfaceId)
			continue;
		if (
			target.invokerHost !== 'main' &&
			target.invokerHost !== 'sidebar' &&
			target.invokerHost !== 'mobile'
		)
			continue;
		if (typeof target.routeIdentity !== 'string') continue;
		const duplicateIndex = normalized.findIndex(
			(item) =>
				item.invokerSurfaceId === target.invokerSurfaceId &&
				item.routeIdentity === target.routeIdentity,
		);
		if (duplicateIndex >= 0) normalized.splice(duplicateIndex, 1);
		normalized.push({ ...target });
	}
	return normalized.slice(-MAX_MOBILE_RETURN_TARGETS);
}

export function canonicalWorkspaceSnapshot(): WorkspaceLayoutSnapshot {
	return {
		main: {
			order: [CHAT_SURFACE_ID, 'singleton:git', 'singleton:pull-requests'],
			activeId: CHAT_SURFACE_ID,
			mru: [CHAT_SURFACE_ID, 'singleton:git', 'singleton:pull-requests'],
		},
		sidebar: {
			order: ['singleton:files', 'singleton:commit'],
			activeId: 'singleton:files',
			mru: ['singleton:files', 'singleton:commit'],
		},
		surfaces: { ...DEFAULT_SURFACES },
		sidebarOpen: false,
		desiredSidebarWidth: DEFAULT_RIGHT_SIDEBAR_WIDTH,
		dialogFileSurfaceId: null,
		manualFullscreen: false,
		mobileActiveSurfaceId: CHAT_SURFACE_ID,
		mobileOnlySurfaceIds: [],
		mobileReturnStack: [],
		unplacedTerminalIds: [],
	};
}

function removeEveryPlacement(
	snapshot: WorkspaceLayoutSnapshot,
	surfaceId: string,
): WorkspaceLayoutSnapshot {
	return {
		...snapshot,
		main: removeFromHost(snapshot.main, surfaceId),
		sidebar: removeFromHost(snapshot.sidebar, surfaceId),
		dialogFileSurfaceId:
			snapshot.dialogFileSurfaceId === surfaceId ? null : snapshot.dialogFileSurfaceId,
		mobileOnlySurfaceIds: snapshot.mobileOnlySurfaceIds.filter((id) => id !== surfaceId),
	};
}

function registerSurface(
	snapshot: WorkspaceLayoutSnapshot,
	mutation: Extract<WorkspaceLayoutMutation, { type: 'register-surface' }>,
): WorkspaceLayoutSnapshot {
	if (snapshot.surfaces[mutation.surface.id]) {
		throw new Error(`Surface already exists: ${mutation.surface.id}`);
	}
	if (
		!mutation.host &&
		mutation.surface.type !== 'file' &&
		!isPortableSingleton(mutation.surface)
	) {
		throw new Error('Only file and portable singleton surfaces may be mobile-only');
	}
	const placedTerminalId =
		mutation.surface.type === 'terminal' ? mutation.surface.terminalId : null;
	let next: WorkspaceLayoutSnapshot = {
		...snapshot,
		surfaces: { ...snapshot.surfaces, [mutation.surface.id]: mutation.surface },
		unplacedTerminalIds: placedTerminalId
			? snapshot.unplacedTerminalIds.filter((terminalId) => terminalId !== placedTerminalId)
			: snapshot.unplacedTerminalIds,
	};
	if (!mutation.host) {
		return {
			...next,
			mobileOnlySurfaceIds: [...next.mobileOnlySurfaceIds, mutation.surface.id],
		};
	}
	const host = insertIntoHost(next[mutation.host], mutation.surface.id, mutation.index);
	next = { ...next, [mutation.host]: host };
	return next;
}

function replaceSurface(
	snapshot: WorkspaceLayoutSnapshot,
	mutation: Extract<WorkspaceLayoutMutation, { type: 'replace-surface' }>,
): WorkspaceLayoutSnapshot {
	if (!snapshot.surfaces[mutation.previousId]) {
		throw new Error(`Surface does not exist: ${mutation.previousId}`);
	}
	if (mutation.previousId !== mutation.surface.id && snapshot.surfaces[mutation.surface.id]) {
		throw new Error(`Replacement surface already exists: ${mutation.surface.id}`);
	}
	const replaceId = (ids: readonly string[]) =>
		ids.map((id) => (id === mutation.previousId ? mutation.surface.id : id));
	const surfaces = { ...snapshot.surfaces };
	const previous = surfaces[mutation.previousId];
	delete surfaces[mutation.previousId];
	surfaces[mutation.surface.id] = mutation.surface;
	let unplacedTerminalIds = [...snapshot.unplacedTerminalIds];
	if (
		previous?.type === 'terminal' &&
		(mutation.surface.type !== 'terminal' ||
			previous.terminalId !== mutation.surface.terminalId)
	) {
		unplacedTerminalIds = unique([...unplacedTerminalIds, previous.terminalId]);
	}
	if (mutation.surface.type === 'terminal') {
		const placedTerminalId = mutation.surface.terminalId;
		unplacedTerminalIds = unplacedTerminalIds.filter(
			(terminalId) => terminalId !== placedTerminalId,
		);
	}
	return {
		...snapshot,
		main: {
			order: replaceId(snapshot.main.order),
			activeId:
				snapshot.main.activeId === mutation.previousId
					? mutation.surface.id
					: snapshot.main.activeId,
			mru: replaceId(snapshot.main.mru),
		},
		sidebar: {
			order: replaceId(snapshot.sidebar.order),
			activeId:
				snapshot.sidebar.activeId === mutation.previousId
					? mutation.surface.id
					: snapshot.sidebar.activeId,
			mru: replaceId(snapshot.sidebar.mru),
		},
		surfaces,
		dialogFileSurfaceId:
			snapshot.dialogFileSurfaceId === mutation.previousId
				? mutation.surface.id
				: snapshot.dialogFileSurfaceId,
		mobileActiveSurfaceId:
			snapshot.mobileActiveSurfaceId === mutation.previousId
				? mutation.surface.id
				: snapshot.mobileActiveSurfaceId,
		mobileOnlySurfaceIds: replaceId(snapshot.mobileOnlySurfaceIds),
		mobileReturnStack: snapshot.mobileReturnStack.map((target) => ({
			...target,
			invokerSurfaceId:
				target.invokerSurfaceId === mutation.previousId
					? mutation.surface.id
					: target.invokerSurfaceId,
		})),
		unplacedTerminalIds,
	};
}

function updateTerminalPlacement(
	snapshot: WorkspaceLayoutSnapshot,
	terminalId: string,
	placement: 'unplaced' | 'forgotten',
): WorkspaceLayoutSnapshot {
	const surfaceId = terminalSurfaceId(terminalId);
	const surface = snapshot.surfaces[surfaceId];
	if (surface && (surface.type !== 'terminal' || surface.terminalId !== terminalId)) {
		throw new Error(`Terminal surface identity mismatch: ${surfaceId}`);
	}
	const next = surface ? removeEveryPlacement(snapshot, surfaceId) : snapshot;
	const surfaces = { ...next.surfaces };
	delete surfaces[surfaceId];
	return {
		...next,
		surfaces,
		sidebarOpen: next.sidebar.order.length > 0 && next.sidebarOpen,
		mobileActiveSurfaceId:
			next.mobileActiveSurfaceId === surfaceId
				? (next.main.activeId ?? CHAT_SURFACE_ID)
				: next.mobileActiveSurfaceId,
		unplacedTerminalIds:
			placement === 'unplaced'
				? unique([...next.unplacedTerminalIds, terminalId])
				: next.unplacedTerminalIds.filter((id) => id !== terminalId),
	};
}

function swapTerminalPlacements(
	snapshot: WorkspaceLayoutSnapshot,
	mutation: Extract<WorkspaceLayoutMutation, { type: 'swap-terminal-placements' }>,
): WorkspaceLayoutSnapshot {
	const first = snapshot.surfaces[mutation.firstSurfaceId];
	const second = snapshot.surfaces[mutation.secondSurfaceId];
	if (first?.type !== 'terminal' || second?.type !== 'terminal') {
		throw new Error('Only terminal surface placements can be swapped');
	}
	const swapId = (id: string): string => {
		if (id === mutation.firstSurfaceId) return mutation.secondSurfaceId;
		if (id === mutation.secondSurfaceId) return mutation.firstSurfaceId;
		return id;
	};
	const swapHost = (host: HostState): HostState => ({
		order: host.order.map(swapId),
		activeId: host.activeId ? swapId(host.activeId) : null,
		mru: host.mru.map(swapId),
	});
	return {
		...snapshot,
		main: swapHost(snapshot.main),
		sidebar: swapHost(snapshot.sidebar),
		mobileActiveSurfaceId: swapId(snapshot.mobileActiveSurfaceId),
		mobileReturnStack: snapshot.mobileReturnStack.map((target) => ({
			...target,
			invokerSurfaceId: swapId(target.invokerSurfaceId),
		})),
	};
}

function moveToHost(
	snapshot: WorkspaceLayoutSnapshot,
	mutation: Extract<WorkspaceLayoutMutation, { type: 'move-to-host' }>,
): WorkspaceLayoutSnapshot {
	if (mutation.surfaceId === CHAT_SURFACE_ID) throw new Error('Chat cannot move');
	if (!snapshot.surfaces[mutation.surfaceId]) {
		throw new Error(`Surface does not exist: ${mutation.surfaceId}`);
	}
	let next = removeEveryPlacement(snapshot, mutation.surfaceId);
	const host = activateHost(
		insertIntoHost(next[mutation.destination], mutation.surfaceId, mutation.index),
		mutation.surfaceId,
	);
	next = {
		...next,
		[mutation.destination]: host,
		sidebarOpen:
			mutation.destination === 'sidebar' ? true : next.sidebar.order.length > 0 && next.sidebarOpen,
	};
	return next;
}

function applyMutation(
	snapshot: WorkspaceLayoutSnapshot,
	mutation: WorkspaceLayoutMutation,
): WorkspaceLayoutSnapshot {
	switch (mutation.type) {
		case 'register-surface':
			return registerSurface(snapshot, mutation);
		case 'replace-surface':
			return replaceSurface(snapshot, mutation);
		case 'swap-terminal-placements':
			return swapTerminalPlacements(snapshot, mutation);
		case 'focus-host': {
			if (!snapshot[mutation.host].order.includes(mutation.surfaceId)) {
				throw new Error(`Surface is not in ${mutation.host}: ${mutation.surfaceId}`);
			}
			return {
				...snapshot,
				[mutation.host]: activateHost(snapshot[mutation.host], mutation.surfaceId),
				sidebarOpen: mutation.host === 'sidebar' ? true : snapshot.sidebarOpen,
			};
		}
		case 'move-to-host':
			return moveToHost(snapshot, mutation);
		case 'assign-to-host': {
			if (mutation.surfaceId === CHAT_SURFACE_ID) throw new Error('Chat cannot move');
			if (!snapshot.surfaces[mutation.surfaceId]) {
				throw new Error(`Surface does not exist: ${mutation.surfaceId}`);
			}
			const next = removeEveryPlacement(snapshot, mutation.surfaceId);
			return {
				...next,
				[mutation.destination]: insertIntoHost(
					next[mutation.destination],
					mutation.surfaceId,
					mutation.index,
				),
			};
		}
		case 'place-in-dialog': {
			const surface = snapshot.surfaces[mutation.surfaceId];
			if (surface?.type !== 'file') throw new Error('Only file surfaces can enter dialog');
			if (snapshot.dialogFileSurfaceId && snapshot.dialogFileSurfaceId !== mutation.surfaceId) {
				throw new Error('Dialog capacity must be resolved before placement');
			}
			return {
				...removeEveryPlacement(snapshot, mutation.surfaceId),
				dialogFileSurfaceId: mutation.surfaceId,
			};
		}
		case 'move-dialog-to-host': {
			if (snapshot.dialogFileSurfaceId !== mutation.surfaceId) {
				throw new Error(`Surface is not in dialog: ${mutation.surfaceId}`);
			}
			return moveToHost(snapshot, {
				type: 'move-to-host',
				surfaceId: mutation.surfaceId,
				destination: mutation.destination,
				index: mutation.index,
			});
		}
		case 'unplace-terminal':
			return updateTerminalPlacement(snapshot, mutation.terminalId, 'unplaced');
		case 'forget-terminal':
			return updateTerminalPlacement(snapshot, mutation.terminalId, 'forgotten');
		case 'remove-surface': {
			if (mutation.surfaceId === CHAT_SURFACE_ID) throw new Error('Chat cannot close');
			if (!snapshot.surfaces[mutation.surfaceId]) return snapshot;
			const next = removeEveryPlacement(snapshot, mutation.surfaceId);
			const surfaces = { ...next.surfaces };
			delete surfaces[mutation.surfaceId];
			return {
				...next,
				surfaces,
				sidebarOpen: next.sidebar.order.length > 0 && next.sidebarOpen,
				mobileActiveSurfaceId:
					next.mobileActiveSurfaceId === mutation.surfaceId
						? (next.main.activeId ?? CHAT_SURFACE_ID)
						: next.mobileActiveSurfaceId,
			};
		}
		case 'set-sidebar-open':
			return {
				...snapshot,
				sidebarOpen: mutation.open,
			};
		case 'set-sidebar-width':
			return { ...snapshot, desiredSidebarWidth: clampDesiredSidebarWidth(mutation.width) };
		case 'set-manual-fullscreen':
			return { ...snapshot, manualFullscreen: mutation.enabled };
		case 'set-mobile-presentation':
			if (!snapshot.surfaces[mutation.activeId]) {
				throw new Error(`Unknown mobile surface: ${mutation.activeId}`);
			}
			return {
				...snapshot,
				mobileActiveSurfaceId: mutation.activeId,
				mobileReturnStack: normalizeReturnStack(mutation.returnStack),
			};
	}
}

export function reduceWorkspaceLayout(
	base: WorkspaceLayoutSnapshot,
	mutations: readonly WorkspaceLayoutMutation[],
): WorkspaceLayoutSnapshot {
	let next = base;
	for (const mutation of mutations) next = applyMutation(next, mutation);
	assertWorkspaceLayoutInvariants(next);
	return next;
}

export function assertWorkspaceLayoutInvariants(snapshot: WorkspaceLayoutSnapshot): void {
	const chatCount = snapshot.main.order.filter((id) => id === CHAT_SURFACE_ID).length;
	if (snapshot.main.order[0] !== CHAT_SURFACE_ID || chatCount !== 1) {
		throw new Error('Chat must exist exactly once at the start of main');
	}
	if (snapshot.sidebar.order.includes(CHAT_SURFACE_ID))
		throw new Error('Chat cannot enter sidebar');
	if (snapshot.dialogFileSurfaceId === CHAT_SURFACE_ID) throw new Error('Chat cannot enter dialog');
	const buckets = new Map<string, number>();
	for (const id of snapshot.main.order) buckets.set(id, (buckets.get(id) ?? 0) + 1);
	for (const id of snapshot.sidebar.order) buckets.set(id, (buckets.get(id) ?? 0) + 1);
	if (snapshot.dialogFileSurfaceId) {
		buckets.set(snapshot.dialogFileSurfaceId, (buckets.get(snapshot.dialogFileSurfaceId) ?? 0) + 1);
	}
	for (const id of snapshot.mobileOnlySurfaceIds) {
		buckets.set(id, (buckets.get(id) ?? 0) + 1);
		const surface = snapshot.surfaces[id];
		if (!surface || (surface.type !== 'file' && !isPortableSingleton(surface))) {
			throw new Error(`Invalid mobile-only surface: ${id}`);
		}
	}
	for (const [id, surface] of Object.entries(snapshot.surfaces)) {
		if (surface.id !== id) throw new Error(`Surface key mismatch: ${id}`);
		if (buckets.get(id) !== 1) throw new Error(`Surface must have one ownership bucket: ${id}`);
	}
	for (const id of buckets.keys()) {
		if (!snapshot.surfaces[id]) throw new Error(`Placement references missing surface: ${id}`);
	}
	if (!snapshot.main.activeId || !snapshot.main.order.includes(snapshot.main.activeId)) {
		throw new Error('Main active surface must be present');
	}
	if (
		(snapshot.sidebar.order.length === 0 && snapshot.sidebar.activeId !== null) ||
		(snapshot.sidebar.order.length > 0 &&
			(!snapshot.sidebar.activeId || !snapshot.sidebar.order.includes(snapshot.sidebar.activeId)))
	) {
		throw new Error('Sidebar active surface must match sidebar contents');
	}
	for (const host of [snapshot.main, snapshot.sidebar]) {
		if (unique(host.order).length !== host.order.length)
			throw new Error('Host order is duplicated');
		if (unique(host.mru).length !== host.mru.length) throw new Error('Host MRU is duplicated');
		if (host.mru.some((id) => !host.order.includes(id))) throw new Error('Host MRU is stale');
		if (host.order.some((id) => !host.mru.includes(id))) throw new Error('Host MRU is incomplete');
	}
	if (snapshot.dialogFileSurfaceId) {
		if (snapshot.surfaces[snapshot.dialogFileSurfaceId]?.type !== 'file') {
			throw new Error('Dialog must reference a file surface');
		}
	}
	if (!snapshot.surfaces[snapshot.mobileActiveSurfaceId]) {
		throw new Error('Mobile active surface must exist');
	}
	if (snapshot.mobileReturnStack.length > MAX_MOBILE_RETURN_TARGETS) {
		throw new Error('Mobile return stack exceeds its cap');
	}
	if (
		unique(snapshot.unplacedTerminalIds).length !== snapshot.unplacedTerminalIds.length ||
		snapshot.unplacedTerminalIds.some((terminalId) => !terminalId)
	) {
		throw new Error('Unplaced terminal IDs must be unique and non-empty');
	}
	for (const terminalId of snapshot.unplacedTerminalIds) {
		if (snapshot.surfaces[terminalSurfaceId(terminalId)]) {
			throw new Error(`Terminal cannot be both placed and unplaced: ${terminalId}`);
		}
	}
	if (clampDesiredSidebarWidth(snapshot.desiredSidebarWidth) !== snapshot.desiredSidebarWidth) {
		throw new Error('Sidebar width is not canonical');
	}
}

function deepFreeze<T>(value: T): T {
	if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	return value;
}

export class WorkspaceLayoutStore implements WorkspaceLayoutReader, WorkspaceLayoutCommitPort {
	#revision = $state(0);
	#snapshot = $state.raw<WorkspaceLayoutSnapshot>(
		import.meta.env.DEV ? deepFreeze(canonicalWorkspaceSnapshot()) : canonicalWorkspaceSnapshot(),
	);

	constructor(initial: WorkspaceLayoutSnapshot = canonicalWorkspaceSnapshot()) {
		assertWorkspaceLayoutInvariants(initial);
		this.#snapshot = import.meta.env.DEV ? deepFreeze(initial) : initial;
	}

	get revision(): number {
		return this.#revision;
	}

	get snapshot(): WorkspaceLayoutSnapshot {
		return this.#snapshot;
	}

	get activeMainId(): string {
		return this.#snapshot.main.activeId ?? CHAT_SURFACE_ID;
	}

	get activeMainKind(): ActiveSurfaceKind | null {
		const surface = this.#snapshot.surfaces[this.activeMainId];
		if (!surface) return null;
		return surface.type === 'singleton' ? surface.kind : surface.type;
	}

	surface(surfaceId: string): SurfaceDescriptor | null {
		return this.#snapshot.surfaces[surfaceId] ?? null;
	}

	publish(expectedRevision: number, next: WorkspaceLayoutSnapshot): boolean {
		if (expectedRevision !== this.#revision) return false;
		assertWorkspaceLayoutInvariants(next);
		this.#snapshot = import.meta.env.DEV ? deepFreeze(next) : next;
		this.#revision += 1;
		return true;
	}
}

export function createWorkspaceLayoutStore(
	initial?: WorkspaceLayoutSnapshot,
): WorkspaceLayoutStore {
	return new WorkspaceLayoutStore(initial);
}
