import type { CodexSubagentInputItem } from './chat-types.js';
import { parseAsyncQuestionReply, type AsyncQuestionReply } from './async-user-questions.js';

export interface ChatImage {
  data: string;
  name: string;
  mimeType?: string;
}

export interface ChatMessageMetadata {
  questionReply?: AsyncQuestionReply;
  contentMode?: 'literal';
  contentFormat?: 'plain' | 'markdown';
  clientRequestId?: string;
  clientMessageId?: string;
  upstreamRequestId?: string;
  turnId?: string;
}

export interface AskUserQuestionOption {
  id: string;
  label: string;
  description?: string;
  preview?: string;
}

export interface AskUserQuestionPrompt {
  id: string;
  prompt: string;
  options: AskUserQuestionOption[];
  header?: string;
  allowMultiple?: boolean;
  allowFreeText?: boolean;
  allowNotes?: boolean;
  isSecret?: boolean;
}

export function asCodexSubagentInputItems(v: unknown): CodexSubagentInputItem[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const items: CodexSubagentInputItem[] = [];
  for (const entry of v) {
    const raw = asRecord(entry);
    const item: CodexSubagentInputItem = {};
    if (typeof raw.type === 'string') item.type = raw.type;
    if (typeof raw.text === 'string') item.text = raw.text;
    if (typeof raw.imageUrl === 'string') item.imageUrl = raw.imageUrl;
    if (typeof raw.path === 'string') item.path = raw.path;
    if (typeof raw.name === 'string') item.name = raw.name;
    if (Object.keys(item).length > 0) items.push(item);
  }
  return items.length > 0 || v.length === 0 ? items : undefined;
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// Unlike asStringArray, keeps blank strings and empty arrays for lossless Monitor round-trips.
export function asOptionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

export function asOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return undefined;
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function parseChatMessageMetadata(value: unknown): ChatMessageMetadata | undefined {
  const raw = asRecord(value);
  const metadata: ChatMessageMetadata = {};
  if (raw.contentMode === 'literal') metadata.contentMode = 'literal';
  if (raw.contentFormat === 'plain' || raw.contentFormat === 'markdown') metadata.contentFormat = raw.contentFormat;
  if (typeof raw.clientRequestId === 'string') metadata.clientRequestId = raw.clientRequestId;
  if (typeof raw.clientMessageId === 'string') metadata.clientMessageId = raw.clientMessageId;
  if (typeof raw.upstreamRequestId === 'string') metadata.upstreamRequestId = raw.upstreamRequestId;
  if (typeof raw.turnId === 'string') metadata.turnId = raw.turnId;
  if (raw.questionReply !== undefined) metadata.questionReply = parseAsyncQuestionReply(raw.questionReply);
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => (
    typeof item === 'string' && item.trim().length > 0
  ));
  return items.length > 0 ? items : undefined;
}

export function asChatImages(value: unknown): ChatImage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const images: ChatImage[] = [];
  for (const entry of value) {
    const raw = asRecord(entry);
    if (typeof raw.data !== 'string' || typeof raw.name !== 'string') continue;
    images.push({
      data: raw.data,
      name: raw.name,
      ...(typeof raw.mimeType === 'string' && raw.mimeType ? { mimeType: raw.mimeType } : {}),
    });
  }
  if (images.length > 0 || value.length === 0) return images;
  return undefined;
}

export function asAllowedPrompts(value: unknown): Array<{ tool: string; prompt: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const prompts: Array<{ tool: string; prompt: string }> = [];
  for (const entry of value) {
    const raw = asRecord(entry);
    if (typeof raw.tool !== 'string' || typeof raw.prompt !== 'string') continue;
    prompts.push({ tool: raw.tool, prompt: raw.prompt });
  }
  if (prompts.length > 0 || value.length === 0) return prompts;
  return undefined;
}

export function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asAskUserQuestionOptions(value: unknown): AskUserQuestionOption[] {
  if (!Array.isArray(value)) return [];
  const options: AskUserQuestionOption[] = [];
  for (const entry of value) {
    const raw = asRecord(entry);
    if (typeof raw.id !== 'string' || typeof raw.label !== 'string') continue;
    const option: AskUserQuestionOption = { id: raw.id, label: raw.label };
    if (typeof raw.description === 'string') option.description = raw.description;
    if (typeof raw.preview === 'string') option.preview = raw.preview;
    options.push(option);
  }
  return options;
}

export function asAskUserQuestions(value: unknown): AskUserQuestionPrompt[] {
  if (!Array.isArray(value)) return [];
  const questions: AskUserQuestionPrompt[] = [];
  for (const entry of value) {
    const raw = asRecord(entry);
    if (typeof raw.id !== 'string' || typeof raw.prompt !== 'string') continue;
    const question: AskUserQuestionPrompt = {
      id: raw.id,
      prompt: raw.prompt,
      options: asAskUserQuestionOptions(raw.options),
    };
    if (typeof raw.header === 'string') question.header = raw.header;
    question.allowMultiple = asOptionalBoolean(raw.allowMultiple);
    question.allowFreeText = asOptionalBoolean(raw.allowFreeText);
    question.allowNotes = asOptionalBoolean(raw.allowNotes);
    question.isSecret = asOptionalBoolean(raw.isSecret);
    questions.push(question);
  }
  return questions;
}

export function asOptionalChanges(value: unknown): Array<{ path?: string; kind?: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const changes: Array<{ path?: string; kind?: string }> = [];
  for (const entry of value) {
    const raw = asRecord(entry);
    const change: { path?: string; kind?: string } = {};
    if (typeof raw.path === 'string') change.path = raw.path;
    if (typeof raw.kind === 'string') change.kind = raw.kind;
    if (change.path !== undefined || change.kind !== undefined) changes.push(change);
  }
  if (changes.length > 0 || value.length === 0) return changes;
  return undefined;
}
