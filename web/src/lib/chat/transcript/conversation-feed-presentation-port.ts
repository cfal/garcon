import type { ConversationPanelRestoreTarget } from './conversation-panel-restore-target.js';

export interface ConversationFeedPresentationPort {
	captureRestoreTarget(): ConversationPanelRestoreTarget | null;
	closeTransients(): void;
}
