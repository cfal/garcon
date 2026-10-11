import { isRecord } from './json.js';
import type { ChatMessageMetadata } from './chat-types.js';

export type InputFormat = 'plain' | 'markdown';
export type InputFormatByModel = Readonly<Record<string, InputFormat>>;

export function isInputFormatByModel(value: unknown): value is InputFormatByModel {
  return isRecord(value) && Object.entries(value).every(([model, format]) =>
    model.length > 0 && (format === 'plain' || format === 'markdown'));
}

export function literalInputFormat(formats: InputFormatByModel, model: string): InputFormat {
  return Object.hasOwn(formats, model) ? formats[model]! : 'plain';
}

export function isPlainTextInput(message: { readonly metadata?: ChatMessageMetadata }): boolean {
  return message.metadata?.contentMode === 'literal' && message.metadata.contentFormat !== 'markdown';
}
