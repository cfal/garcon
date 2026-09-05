import {
	chatViewSurfaceId,
	portableSingletonDescriptor,
	singletonSurfaceId,
	type ChatViewSurfaceDescriptor,
	type WorkspaceLayoutSnapshot,
	type WorkspacePartitionId,
	type WorkspaceWindowId,
	type WorkspaceWindowNode,
} from './surface-types.js';

export const CANONICAL_WINDOW_ID: WorkspaceWindowId = 'window-main';
export const CANONICAL_CHAT_SURFACE_ID = chatViewSurfaceId(CANONICAL_WINDOW_ID);
export const CANONICAL_FILES_WINDOW_ID: WorkspaceWindowId = 'window-files';
export const CANONICAL_FILES_SURFACE_ID = singletonSurfaceId('files');

const CANONICAL_PARTITION_ID: WorkspacePartitionId = 'partition-main';
// Chat is the primary surface, so it takes the larger share of the split.
const CANONICAL_CHAT_PARTITION_RATIO = 0.62;

const CANONICAL_CHAT_DESCRIPTOR: ChatViewSurfaceDescriptor = {
	id: CANONICAL_CHAT_SURFACE_ID,
	type: 'chat',
	chatId: null,
};

const CANONICAL_FILES_DESCRIPTOR = portableSingletonDescriptor('files');

function canonicalWindow(id: WorkspaceWindowId, surfaceId: string): WorkspaceWindowNode {
	return {
		type: 'window',
		id,
		tabs: { order: [surfaceId], activeId: surfaceId, mru: [surfaceId] },
	};
}

export function canonicalWorkspaceSnapshot(): WorkspaceLayoutSnapshot {
	return {
		desktopRoot: {
			type: 'partition',
			id: CANONICAL_PARTITION_ID,
			direction: 'horizontal',
			ratio: CANONICAL_CHAT_PARTITION_RATIO,
			children: [
				canonicalWindow(CANONICAL_WINDOW_ID, CANONICAL_CHAT_SURFACE_ID),
				canonicalWindow(CANONICAL_FILES_WINDOW_ID, CANONICAL_FILES_SURFACE_ID),
			],
		},
		surfaces: {
			[CANONICAL_CHAT_SURFACE_ID]: CANONICAL_CHAT_DESCRIPTOR,
			[CANONICAL_FILES_SURFACE_ID]: CANONICAL_FILES_DESCRIPTOR,
		},
		fullscreenWindowId: null,
		dialogFileSurfaceId: null,
		mobileActiveSurfaceId: CANONICAL_CHAT_SURFACE_ID,
		mobileOnlySurfaceIds: [],
		mobileReturnStack: [],
		unplacedTerminalIds: [],
	};
}

export function isCanonicalFirstRunLayout(snapshot: WorkspaceLayoutSnapshot): boolean {
	if (
		snapshot.desktopRoot.type !== 'partition' ||
		snapshot.desktopRoot.id !== CANONICAL_PARTITION_ID ||
		snapshot.desktopRoot.direction !== 'horizontal'
	) {
		return false;
	}
	const [chatWindow, filesWindow] = snapshot.desktopRoot.children;
	const chat = snapshot.surfaces[CANONICAL_CHAT_SURFACE_ID];
	const files = snapshot.surfaces[CANONICAL_FILES_SURFACE_ID];
	return (
		chatWindow.type === 'window' &&
		chatWindow.id === CANONICAL_WINDOW_ID &&
		chatWindow.tabs.order.length === 1 &&
		chatWindow.tabs.order[0] === CANONICAL_CHAT_SURFACE_ID &&
		chatWindow.tabs.activeId === CANONICAL_CHAT_SURFACE_ID &&
		filesWindow.type === 'window' &&
		filesWindow.id === CANONICAL_FILES_WINDOW_ID &&
		filesWindow.tabs.order.length === 1 &&
		filesWindow.tabs.order[0] === CANONICAL_FILES_SURFACE_ID &&
		filesWindow.tabs.activeId === CANONICAL_FILES_SURFACE_ID &&
		chat?.type === 'chat' &&
		chat.chatId === null &&
		files?.type === 'singleton' &&
		files.kind === 'files' &&
		!snapshot.fullscreenWindowId &&
		!snapshot.dialogFileSurfaceId &&
		snapshot.mobileOnlySurfaceIds.length === 0 &&
		snapshot.unplacedTerminalIds.length === 0
	);
}
