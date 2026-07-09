import type { HttpErrorResponse } from './http-error.js';

export interface GenerateChatTitleRequest {
  chatId: string;
  message: string;
  messageSeq?: number;
}

export interface GenerateChatTitleResponse {
  success: true;
  chatId: string;
  title: string;
}

export type GenerateChatTitleErrorCode =
  | 'VALIDATION_FAILED'
  | 'SESSION_NOT_FOUND'
  | 'TITLE_GENERATION_UNAVAILABLE'
  | 'TITLE_GENERATION_EMPTY'
  | 'TITLE_GENERATION_FAILED';

export interface GenerateChatTitleErrorResponse extends HttpErrorResponse {
  errorCode: GenerateChatTitleErrorCode;
}
