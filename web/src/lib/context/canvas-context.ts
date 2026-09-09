import { createContext } from 'svelte';
import type { CanvasDocumentState } from '$lib/chat-canvas/canvas-document.svelte';
import type { ChatSessionRecord } from '$lib/types/chat-session';

export interface CanvasViewPort {
	readonly document: CanvasDocumentState;
	readonly chats: Readonly<Record<string, ChatSessionRecord>>;
	readonly currentTime: Date;
	readonly readOnly: boolean;
	openChat(id: string): void;
}

export const [getCanvasView, setCanvasView] = createContext<CanvasViewPort>();
