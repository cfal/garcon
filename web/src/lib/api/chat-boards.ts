import {
	normalizeChatBoardCatalog,
	normalizeChatBoardMutationResponse,
	normalizeCreateChatBoardResponse,
	type ChatBoard,
	type ChatBoardCatalog,
	type ChatBoardMutationResponse,
	type CreateChatBoardResponse,
} from '$shared/chat-boards';
import { apiDelete, apiGet, apiPost, apiPut } from './client.js';

function requireCatalog(value: unknown): ChatBoardCatalog {
	const catalog = normalizeChatBoardCatalog(value);
	if (!catalog) throw new Error('Invalid chat board catalog response');
	return catalog;
}

function requireMutation(value: unknown): ChatBoardMutationResponse {
	const result = normalizeChatBoardMutationResponse(value);
	if (!result) throw new Error('Invalid chat board mutation response');
	return result;
}

export interface ChatBoardApi {
	load(): Promise<ChatBoardCatalog>;
	create(expectedRevision: number, name: string): Promise<CreateChatBoardResponse>;
	update(expectedRevision: number, board: ChatBoard): Promise<ChatBoardMutationResponse>;
	remove(expectedRevision: number, boardId: string): Promise<ChatBoardMutationResponse>;
	reorder(expectedRevision: number, orderedBoardIds: readonly string[]): Promise<ChatBoardMutationResponse>;
}

export const chatBoardApi: ChatBoardApi = {
	async load() {
		return requireCatalog(await apiGet<unknown>('/api/v1/chat-boards'));
	},
	async create(expectedRevision, name) {
		const result = normalizeCreateChatBoardResponse(await apiPost<unknown>('/api/v1/chat-boards', {
			expectedRevision,
			name,
		}));
		if (!result) throw new Error('Invalid create chat board response');
		return result;
	},
	async update(expectedRevision, board) {
		return requireMutation(await apiPut<unknown>('/api/v1/chat-boards', {
			expectedRevision,
			board,
		}));
	},
	async remove(expectedRevision, boardId) {
		return requireMutation(await apiDelete<unknown>('/api/v1/chat-boards', {
			expectedRevision,
			boardId,
		}));
	},
	async reorder(expectedRevision, orderedBoardIds) {
		return requireMutation(await apiPut<unknown>('/api/v1/chat-boards/order', {
			expectedRevision,
			orderedBoardIds,
		}));
	},
};
