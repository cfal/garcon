import type {
	PersistedWorkspaceHost,
	PersistedWorkspaceLayoutV1,
	PersistedWorkspaceSurfaceRef,
} from '$shared/workspace-layout';
import {
	CHAT_SURFACE_ID,
	type HostId,
	type SurfaceDescriptor,
	type WorkspaceLayoutSnapshot,
	singletonSurfaceId,
	terminalSurfaceId,
} from './surface-types';
import {
	assertWorkspaceLayoutInvariants,
	canonicalWorkspaceSnapshot,
} from '$lib/stores/workspace-layout.svelte';
import { clampDesiredSidebarWidth } from './sidebar-sizing';

export type WorkspaceLayoutRestoreSource = 'absent' | 'valid' | 'fallback';

export interface WorkspaceLayoutParseResult {
	source: WorkspaceLayoutRestoreSource;
	snapshot: WorkspaceLayoutSnapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseRef(value: unknown): PersistedWorkspaceSurfaceRef | null {
	if (!isRecord(value)) return null;
	if (
		value.type === 'singleton' &&
		(value.kind === 'git' ||
			value.kind === 'pull-requests' ||
			value.kind === 'files' ||
			value.kind === 'commit')
	) {
		return { type: 'singleton', kind: value.kind };
	}
	if (value.type === 'terminal' && typeof value.terminalId === 'string' && value.terminalId) {
		return { type: 'terminal', terminalId: value.terminalId };
	}
	return null;
}

function parseHost(value: unknown): PersistedWorkspaceHost | null {
	if (!isRecord(value) || !Array.isArray(value.order)) return null;
	const order = value.order
		.map(parseRef)
		.filter((ref): ref is PersistedWorkspaceSurfaceRef => Boolean(ref));
	const active = value.active === null ? null : parseRef(value.active);
	return { order, active };
}

function refKey(ref: PersistedWorkspaceSurfaceRef): string {
	return ref.type === 'singleton'
		? singletonSurfaceId(ref.kind)
		: terminalSurfaceId(ref.terminalId);
}

function descriptorFor(ref: PersistedWorkspaceSurfaceRef): SurfaceDescriptor {
	if (ref.type === 'terminal') {
		return { id: terminalSurfaceId(ref.terminalId), type: 'terminal', terminalId: ref.terminalId };
	}
	switch (ref.kind) {
		case 'git':
			return { id: singletonSurfaceId(ref.kind), type: 'singleton', kind: ref.kind };
		case 'pull-requests':
			return { id: singletonSurfaceId(ref.kind), type: 'singleton', kind: ref.kind };
		case 'files':
			return { id: singletonSurfaceId(ref.kind), type: 'singleton', kind: ref.kind };
		case 'commit':
			return { id: singletonSurfaceId(ref.kind), type: 'singleton', kind: ref.kind };
	}
}

function restoreHost(
	host: PersistedWorkspaceHost,
	hostId: HostId,
	seen: Set<string>,
	surfaces: Record<string, SurfaceDescriptor>,
): { order: string[]; activeId: string | null; mru: string[] } {
	const order: string[] = [];
	for (const ref of host.order) {
		const id = refKey(ref);
		if (id === CHAT_SURFACE_ID || seen.has(id)) continue;
		seen.add(id);
		order.push(id);
		surfaces[id] = descriptorFor(ref);
	}
	if (hostId === 'main') order.unshift(CHAT_SURFACE_ID);
	const activeKey = host.active ? refKey(host.active) : null;
	const activeId =
		activeKey && order.includes(activeKey)
			? activeKey
			: hostId === 'main'
				? CHAT_SURFACE_ID
				: (order[0] ?? null);
	const mru = activeId ? [activeId, ...order.filter((id) => id !== activeId)] : [];
	return { order, activeId, mru };
}

export function parsePersistedWorkspaceLayout(raw: string | null): WorkspaceLayoutParseResult {
	if (raw === null) return { source: 'absent', snapshot: canonicalWorkspaceSnapshot() };
	try {
		const value: unknown = JSON.parse(raw);
		if (!isRecord(value) || value.version !== 1) throw new Error('Unsupported layout version');
		const mainRecord = parseHost(value.main);
		const sidebarRecord = parseHost(value.sidebar);
		if (!mainRecord || !sidebarRecord) throw new Error('Invalid persisted hosts');
		const mainBase = canonicalWorkspaceSnapshot();
		const surfaces: Record<string, SurfaceDescriptor> = {
			[CHAT_SURFACE_ID]: mainBase.surfaces[CHAT_SURFACE_ID],
		};
		const seen = new Set<string>();
		const main = restoreHost(mainRecord, 'main', seen, surfaces);
		const sidebar = restoreHost(sidebarRecord, 'sidebar', seen, surfaces);
		const unplacedTerminalIds = Array.isArray(value.unplacedTerminalIds)
			? [
					...new Set(
						value.unplacedTerminalIds.filter(
							(terminalId): terminalId is string =>
								typeof terminalId === 'string' &&
								Boolean(terminalId) &&
								!seen.has(terminalSurfaceId(terminalId)),
						),
					),
				]
			: [];
		const snapshot: WorkspaceLayoutSnapshot = {
			main,
			sidebar,
			surfaces,
			sidebarOpen: Boolean(value.sidebarOpen) && sidebar.order.length > 0,
			desiredSidebarWidth: clampDesiredSidebarWidth(
				typeof value.desiredSidebarWidth === 'number'
					? value.desiredSidebarWidth
					: mainBase.desiredSidebarWidth,
			),
			dialogFileSurfaceId: null,
			manualFullscreen: false,
			mobileActiveSurfaceId: CHAT_SURFACE_ID,
			mobileOnlySurfaceIds: [],
			mobileReturnStack: [],
			unplacedTerminalIds,
		};
		assertWorkspaceLayoutInvariants(snapshot);
		return { source: 'valid', snapshot };
	} catch {
		return { source: 'fallback', snapshot: canonicalWorkspaceSnapshot() };
	}
}

function persistedRef(surface: SurfaceDescriptor): PersistedWorkspaceSurfaceRef | null {
	if (surface.type === 'terminal') return { type: 'terminal', terminalId: surface.terminalId };
	if (surface.type !== 'singleton' || surface.kind === 'chat') return null;
	return { type: 'singleton', kind: surface.kind };
}

function serializeHost(
	host: WorkspaceLayoutSnapshot['main'],
	surfaces: WorkspaceLayoutSnapshot['surfaces'],
): PersistedWorkspaceHost {
	const order = host.order.flatMap((id) => {
		const ref = surfaces[id] ? persistedRef(surfaces[id]) : null;
		return ref ? [ref] : [];
	});
	const activeSurface = host.activeId ? surfaces[host.activeId] : null;
	return { order, active: activeSurface ? persistedRef(activeSurface) : null };
}

export function serializeWorkspaceLayout(
	snapshot: WorkspaceLayoutSnapshot,
): PersistedWorkspaceLayoutV1 {
	return {
		version: 1,
		desiredSidebarWidth: clampDesiredSidebarWidth(snapshot.desiredSidebarWidth),
		sidebarOpen: snapshot.sidebarOpen,
		main: serializeHost(snapshot.main, snapshot.surfaces),
		sidebar: serializeHost(snapshot.sidebar, snapshot.surfaces),
		unplacedTerminalIds: [...snapshot.unplacedTerminalIds],
	};
}
