import {
	chatViewSurfaceId,
	type ChatViewSurfaceDescriptor,
	type WorkspaceLayoutSnapshot,
	type WorkspaceWindowId,
} from './surface-types.js';

export const CANONICAL_WINDOW_ID: WorkspaceWindowId = 'window-main';
export const CANONICAL_CHAT_SURFACE_ID = chatViewSurfaceId(CANONICAL_WINDOW_ID);

const CANONICAL_CHAT_DESCRIPTOR: ChatViewSurfaceDescriptor = {
	id: CANONICAL_CHAT_SURFACE_ID,
	type: 'chat',
	chatId: null,
};

export function canonicalWorkspaceSnapshot(): WorkspaceLayoutSnapshot {
	return {
		desktopRoot: {
			type: 'window',
			id: CANONICAL_WINDOW_ID,
			tabs: {
				order: [CANONICAL_CHAT_SURFACE_ID],
				activeId: CANONICAL_CHAT_SURFACE_ID,
				mru: [CANONICAL_CHAT_SURFACE_ID],
			},
		},
		surfaces: { [CANONICAL_CHAT_SURFACE_ID]: CANONICAL_CHAT_DESCRIPTOR },
		fullscreenWindowId: null,
		dialogFileSurfaceId: null,
		mobileActiveSurfaceId: CANONICAL_CHAT_SURFACE_ID,
		mobileOnlySurfaceIds: [],
		mobileReturnStack: [],
		unplacedTerminalIds: [],
	};
}

export function isCanonicalFirstRunLayout(snapshot: WorkspaceLayoutSnapshot): boolean {
	if (snapshot.desktopRoot.type !== 'window' || snapshot.desktopRoot.id !== CANONICAL_WINDOW_ID) {
		return false;
	}
	const chat = snapshot.surfaces[CANONICAL_CHAT_SURFACE_ID];
	return (
		chat?.type === 'chat' &&
		chat.chatId === null &&
		snapshot.desktopRoot.tabs.order.length === 1 &&
		snapshot.desktopRoot.tabs.order[0] === CANONICAL_CHAT_SURFACE_ID &&
		snapshot.desktopRoot.tabs.activeId === CANONICAL_CHAT_SURFACE_ID &&
		!snapshot.fullscreenWindowId &&
		!snapshot.dialogFileSurfaceId &&
		snapshot.mobileOnlySurfaceIds.length === 0 &&
		snapshot.unplacedTerminalIds.length === 0
	);
}
