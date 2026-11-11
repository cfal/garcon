import { parseChatId, type ChatId } from './chat-id.js';
import { isRecord } from './json.js';
import { SCHEDULED_PROMPT_MAX_LENGTH } from './scheduled-prompts.js';

export interface RenderScheduledPromptRequest {
  readonly chatId: ChatId;
  readonly prompt: string;
}

export interface RenderScheduledPromptResponse {
  readonly success: true;
  readonly chatId: ChatId;
  readonly expandedText: string;
}

function validPrompt(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= SCHEDULED_PROMPT_MAX_LENGTH;
}

export function parseRenderScheduledPromptRequest(value: unknown): RenderScheduledPromptRequest | null {
  if (!isRecord(value) || !validPrompt(value.prompt)) return null;
  try {
    return { chatId: parseChatId(value.chatId), prompt: value.prompt };
  } catch {
    return null;
  }
}

export function parseRenderScheduledPromptResponse(value: unknown): RenderScheduledPromptResponse | null {
  if (!isRecord(value) || value.success !== true || !validPrompt(value.expandedText)) return null;
  try {
    return { success: true, chatId: parseChatId(value.chatId), expandedText: value.expandedText };
  } catch {
    return null;
  }
}
