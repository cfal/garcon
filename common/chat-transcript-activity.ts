import {
  ExitPlanModeToolUseMessage,
  parseChatMessage,
  type ChatMessage,
} from './chat-types';
import { isRecord } from './json';

const PREVIEW_MAX_CHARS = 200;

export interface ChatTranscriptPreview {
  readonly content: string;
  readonly timestamp: string;
}

// Chat-level facts derived from one committed transcript batch. Every browser
// socket receives them, whether or not it displays the chat, so the sidebar,
// unread state, and plan-mode controls never depend on transcript bodies.
export interface ChatTranscriptActivity {
  readonly preview: ChatTranscriptPreview | null;
  readonly lastActivityAt: string | null;
  readonly planModeEntered: boolean;
  // The plan approval control outlives the rendered row, so it carries the tool use.
  readonly planExitRequests: readonly ExitPlanModeToolUseMessage[];
}

export function previewFirstLine(text: string): string {
  if (!text) return '';
  const newline = text.indexOf('\n');
  if (newline < 0) return text.trim();
  return text.slice(0, newline).trim();
}

export function summarizeTranscriptActivity(
  messages: readonly ChatMessage[],
): ChatTranscriptActivity {
  let preview: ChatTranscriptPreview | null = null;
  let lastActivityAt: string | null = null;
  let planModeEntered = false;
  const planExitRequests: ExitPlanModeToolUseMessage[] = [];
  for (const message of messages) {
    const timestamp = message.timestamp;
    if (timestamp && (!lastActivityAt || timestamp > lastActivityAt)) lastActivityAt = timestamp;
    // Discriminates by type because server rows may be decoded plain objects.
    if (
      message.type === 'assistant-message'
      || message.type === 'user-message'
      || message.type === 'command-output'
    ) {
      preview = {
        content: previewFirstLine(String(message.content || '')).slice(0, PREVIEW_MAX_CHARS),
        timestamp: message.timestamp,
      };
    }
    if (message.type === 'enter-plan-mode-tool-use') planModeEntered = true;
    if (message.type === 'exit-plan-mode-tool-use') planExitRequests.push(message);
  }
  return { preview, lastActivityAt, planModeEntered, planExitRequests };
}

function parsePreview(value: unknown): ChatTranscriptPreview | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  if (typeof value.content !== 'string' || typeof value.timestamp !== 'string') return undefined;
  return { content: value.content, timestamp: value.timestamp };
}

export function parseChatTranscriptActivity(value: unknown): ChatTranscriptActivity | null {
  if (!isRecord(value)) return null;
  const preview = parsePreview(value.preview);
  if (preview === undefined) return null;
  const lastActivityAt = value.lastActivityAt;
  if (lastActivityAt !== null && typeof lastActivityAt !== 'string') return null;
  if (typeof value.planModeEntered !== 'boolean' || !Array.isArray(value.planExitRequests)) {
    return null;
  }
  const planExitRequests: ExitPlanModeToolUseMessage[] = [];
  for (const item of value.planExitRequests) {
    const message = parseChatMessage(item);
    if (!(message instanceof ExitPlanModeToolUseMessage)) return null;
    planExitRequests.push(message);
  }
  return {
    preview,
    lastActivityAt,
    planModeEntered: value.planModeEntered,
    planExitRequests,
  };
}
