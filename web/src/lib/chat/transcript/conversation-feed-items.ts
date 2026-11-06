import type { ChatMessage, ToolUseChatMessage, ToolResultMessage } from '$shared/chat-types';
import type { LocalNoticeRow } from './local-notice.js';

export interface PermissionTerminalState {
	permissionOccurrenceId: string;
	state: 'resolved' | 'cancelled';
	allowed?: boolean;
	reason?: string;
	selectedQuestionOptions?: Record<string, string[]>;
	questionTextAnswers?: Record<string, string>;
}

export interface ConversationFeedMessageRenderItem {
	kind: 'message';
	id: string;
	message: ChatMessage;
	index: number;
	ordinal?: number;
	awaitingDelivery?: boolean;
	pairedToolUse?: ToolUseChatMessage;
	layout?: 'standard' | 'permission';
}

export type ConversationFeedRenderItem =
	| ConversationFeedMessageRenderItem
	| {
			kind: 'local-notice';
			id: string;
			notice: LocalNoticeRow;
			index: number;
	  };

export interface ConversationFeedRenderModel {
	items: ConversationFeedRenderItem[];
	toolResultByUseRowId: Map<string, ToolResultMessage>;
	toolResultRowIdByUseRowId: Map<string, string>;
	permissionTerminalByOccurrence: Map<string, PermissionTerminalState>;
}
