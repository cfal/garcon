export const CHAT_WINDOW_TEXT_SCALE_DEFAULT = 1;
export const CHAT_WINDOW_TEXT_SCALE_TWO_WINDOWS = 0.85;
export const CHAT_WINDOW_TEXT_SCALE_FOUR_WINDOWS = 0.7;

export function getChatWindowTextScale(workspaceWindowCount: number): number {
	if (workspaceWindowCount >= 4) return CHAT_WINDOW_TEXT_SCALE_FOUR_WINDOWS;
	if (workspaceWindowCount >= 2) return CHAT_WINDOW_TEXT_SCALE_TWO_WINDOWS;
	return CHAT_WINDOW_TEXT_SCALE_DEFAULT;
}
