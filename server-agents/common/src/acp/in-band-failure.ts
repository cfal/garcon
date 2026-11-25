import { acpContentText, asObject, asString } from './event-converter.js';

// Agents such as Antigravity report some failures as a marked message chunk and
// then end the turn normally. The chunk counts as a failure only if nothing
// follows it before the turn ends; any further output means the chunk was
// ordinary text that quoted the marker.

export type AcpFailureSplitter = (chunk: string) => { readonly text: string; readonly failure: string | null };

const TEXT_OUTPUT_UPDATES = new Set([
  'agent_message_chunk',
  'agent_message',
  'agent_thought_chunk',
]);
// Text and new calls disprove a candidate failure; progress on a known tool can arrive after one.
export const ACP_NEW_OUTPUT_UPDATES: ReadonlySet<string> = new Set([...TEXT_OUTPUT_UPDATES, 'tool_call']);

function isEmptyText(content: unknown): boolean {
  if (Array.isArray(content)) return content.every(isEmptyText);
  return content === '' || (asObject(content).type === 'text' && acpContentText(content) === '');
}

// The update type that new-output checks see: a tool_call_update reports on an
// earlier call, except when it is the first frame of a call.
export function acpOutputUpdateType(
  update: Record<string, unknown>,
  isKnownCall: (toolCallId: string) => boolean,
): string | undefined {
  const updateType = asString(update.sessionUpdate);
  if (updateType && TEXT_OUTPUT_UPDATES.has(updateType) && isEmptyText(update.content)) return undefined;
  if (updateType !== 'tool_call_update') return updateType;
  const toolCallId = asString(update.toolCallId);
  return !toolCallId || isKnownCall(toolCallId) ? updateType : 'tool_call';
}

export class AcpInBandFailure {
  #pending: { readonly failure: string; readonly text: string } | null = null;

  constructor(private readonly split: AcpFailureSplitter) {}

  // Returns held-back text that turned out to be ordinary output, or ''.
  continueOn(updateType: string | undefined): string {
    if (!this.#pending || !ACP_NEW_OUTPUT_UPDATES.has(updateType ?? '')) return '';
    const text = this.#pending.text;
    this.#pending = null;
    return text;
  }

  // Returns the chunk's text to publish now; a candidate failure is held back.
  offer(chunk: string): string {
    const { text, failure } = this.split(chunk);
    if (failure) this.#pending = { failure, text: chunk.slice(text.length) };
    return text;
  }

  take(): string | null {
    const failure = this.#pending?.failure ?? null;
    this.#pending = null;
    return failure;
  }

  reset(): void {
    this.#pending = null;
  }
}
