import { isToolUseMessage, parseChatMessage, type ChatMessage } from '../../../../../common/chat-types.ts';
import {
  boundProjectedMessage as bound,
  createCarryoverTranscript as create,
  createCarryoverTranscriptWithinCost as withinCost,
  isProjectableMessage as projectable,
  isPublicationGapMessage as publicationGap,
  parseNativeSeedReceipt,
  projectToolUseSummary as summarize,
  renderCarriedContext as render,
  renderTranscriptSeed as renderLegacy,
  retargetNativeSeedReceiptIfPreserved as retarget,
  sanitizeRecordedCarriedContext as sanitize,
  type NativeSeedReceipt,
} from '../../../../../common/transcript-seed.ts';

// The recorder cannot encode class arguments or callbacks. Construct those
// on the original side, and inspect returned messages at the JSON boundary.
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
function message(raw: unknown): ChatMessage {
  const parsed = parseChatMessage(raw);
  if (parsed === null) throw new Error('Invalid fixture message');
  return parsed;
}

export function acceptsMessage(raw: unknown): boolean {
  return parseChatMessage(raw) !== null;
}

export function acceptsMessages(raw: unknown): boolean {
  return Array.isArray(raw) && raw.every(acceptsMessage);
}

export function acceptsTool(raw: unknown): boolean {
  const parsed = parseChatMessage(raw);
  return parsed !== null && isToolUseMessage(parsed);
}

export function acceptsReceipt(raw: unknown): boolean {
  return raw === null || parseNativeSeedReceipt(raw) !== null;
}

export function createCarryoverTranscript(raw: unknown[], maxChars: number, summary?: string) {
  return create(raw.map(message), maxChars, { summary });
}

export function createCarryoverTranscriptWithinCost(raw: unknown[], maximumCost: number, summary?: string) {
  return withinCost(raw.map(message), {
    maximumCost, cost: text => text.length + text.split('\n').length - 1,
  }, { summary });
}

export function renderCarriedContext(raw: unknown[], maxChars?: number) {
  return render(raw.map(message), { maxChars });
}

export function renderTranscriptSeed(raw: unknown[], maxChars?: number, fromAgentLabel?: string) {
  return renderLegacy(raw.map(message), { maxChars, fromAgentLabel });
}

export function boundProjectedMessage(raw: unknown) {
  return wire(bound(message(raw)));
}

export function isProjectableMessage(raw: unknown) {
  return projectable(message(raw));
}

export function isPublicationGapMessage(raw: unknown) {
  return publicationGap(message(raw));
}

export function projectToolUseSummary(raw: unknown, redact?: boolean) {
  const tool = message(raw);
  if (!isToolUseMessage(tool)) throw new Error('Invalid fixture tool');
  return summarize(tool, redact ? value => value.replaceAll('Secret', '[redacted]') : undefined);
}

export function sanitizeRecordedCarriedContext(
  raw: unknown[], receipt: NativeSeedReceipt | null, agentSessionId: string | null,
) {
  return wire(sanitize({ messages: raw.map(message), receipt, agentSessionId }));
}

export function retargetNativeSeedReceiptIfPreserved(
  receipt: NativeSeedReceipt | null, agentSessionId: string, raw: unknown[],
) {
  return retarget(receipt, agentSessionId, raw.map(message));
}
