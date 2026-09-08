import type { ChatBoardFocusTarget } from './chat-board-focus-controller.js';

export interface ChatBoardPanelMemory {
	readonly laneScrollOffsets: Map<string, number>;
	focusTarget: ChatBoardFocusTarget | null;
}

const memoryByController = new WeakMap<object, ChatBoardPanelMemory>();

export function getChatBoardPanelMemory(controller: object): ChatBoardPanelMemory {
	const existing = memoryByController.get(controller);
	if (existing) return existing;
	const memory: ChatBoardPanelMemory = {
		laneScrollOffsets: new Map(),
		focusTarget: null,
	};
	memoryByController.set(controller, memory);
	return memory;
}
