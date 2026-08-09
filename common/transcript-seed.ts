import crypto from 'node:crypto';
import type { ChatMessage, TodoItem, ToolUseChatMessage } from './chat-types.js';
import { UserMessage, isToolUseMessage } from './chat-types.js';

export const SEED_CONTEXT_OPEN = '<carried-context>';
export const SEED_CONTEXT_CLOSE = '</carried-context>';
export const CARRIED_CONTEXT_VERSION = 3 as const;

// Assembled only when a compaction model will reduce it before injection.
export const CARRYOVER_COMPACTION_INPUT_MAX_CHARS = 500_000;
// Ceiling on injected text, whether rendered directly or returned by compaction.
export const CARRYOVER_INJECTION_MAX_CHARS = 250_000;

const CARRIED_CONTEXT_OPEN_PREFIX = '<carried-context';
const CARRIED_CONTEXT_PREAMBLE =
  'Previous conversation context follows. Continue from it without repeating it.';
// Only the legacy renderer uses this, and it must stay at the value older
// releases shipped: the migration hashes that output to strip a legacy seed, so
// changing the cap would change the reproduced bytes.
const LEGACY_SEED_MAX_CHARS = 12_000;
const TOOL_SUMMARY_MAX_CHARS = 200;
const MESSAGE_PROJECTION_MAX_CHARS = 4_000;
const TRUNCATION_ELEMENT = '    <earlier-turns-truncated/>';
// The newest turns are admitted whole, at every level, before the ladder runs.
// The ladder admits by class, so without this the newest turn keeps its prose but
// can lose the commands that went with it, leaving the working set uncompressed
// yet incomplete.
const RECENT_TURNS_VERBATIM = 3;

// Message classes admitted in order while the budget holds. Conversation first
// because the asks are irreducible, then file activity because it is durable
// state, then command history, which is the bulk and the least durable signal.
const LADDER: readonly (readonly string[])[] = [
  ['user-message'],
  ['assistant-message'],
  ['read-tool-use', 'grep-tool-use', 'glob-tool-use', 'list-tool-use'],
  ['edit-tool-use', 'write-tool-use', 'apply-patch-tool-use'],
  ['bash-tool-use', 'exec-tool-use'],
];
const LONG_TAIL_LEVEL = LADDER.length;
const READ_LEVEL = 2;
const EDIT_LEVEL = 3;
const AGGREGATED_READS = new Set(['read-tool-use']);
const AGGREGATED_EDITS = new Set(['edit-tool-use', 'write-tool-use', 'apply-patch-tool-use']);

export interface NativeSeedReceipt {
  readonly agentSessionId: string;
  readonly placement: 'user-prefix' | 'provider-context';
  readonly format: 'v3-xml' | 'v2-xml' | 'v1-marker' | 'legacy-v0';
  readonly codeUnitLength: number;
  readonly sha256: string;
}

interface ProjectedEntry {
  readonly level: number;
  readonly turn: number;
  readonly text: string;
  refit(maximum: number): string;
}

export interface CarriedContext {
  readonly prefix: string;
}

export type SanitizeCarriedContextResult =
  | { readonly kind: 'not-applicable'; readonly messages: readonly ChatMessage[] }
  | { readonly kind: 'stripped-exact'; readonly messages: readonly ChatMessage[] }
  | { readonly kind: 'absent'; readonly messages: readonly ChatMessage[] }
  | {
      readonly kind: 'mismatch';
      readonly messages: readonly ChatMessage[];
      readonly reason: string;
    };

// Assembles the carried-context envelope within a character budget. Callers pass
// the injection ceiling directly, or the larger compaction-input ceiling when a
// model will reduce the result before it reaches a provider.
export function createCarryoverTranscript(
  messages: readonly ChatMessage[],
  maxChars: number,
  options: { readonly summary?: string } = {},
): CarriedContext | null {
  const projected = messages.filter(isProjectableMessage);
  // A summary with no surviving transcript is still worth carrying; it is the
  // compacted history.
  if (projected.length === 0 && !options.summary) return null;

  const opening = [
    `<carried-context version="${CARRIED_CONTEXT_VERSION}">`,
    `  <instructions>${CARRIED_CONTEXT_PREAMBLE}</instructions>`,
    '  <transcript>',
  ].join('\n');
  const closing = '  </transcript>\n</carried-context>\n\n';
  // Rendered inside the same envelope as the transcript rather than beside it.
  // A second root would escape `sanitizeRecordedCarriedContext`'s rewritten-
  // envelope guard, which anchors on the prefix starting with `<carried-context`.
  // Normalized but never clipped: the per-message bound exists to stop one chat
  // message dominating the budget, and the summary *is* the compacted history,
  // so the budget alone governs it. An oversized one leaves the prefix over the
  // ceiling, which the compaction caller detects and falls back from.
  const summaryElement = options.summary
    ? fitElement('    <summary>', collapseWhitespace(options.summary), '</summary>', Number.POSITIVE_INFINITY)
    : '';
  const lead = summaryElement ? `${summaryElement}\n` : '';
  const turns = groupIntoTurns(projected);
  const entries = turns.flatMap((turn, index) => renderTurn(turn, index));
  if (entries.length === 0 && !summaryElement) return null;

  const body = entries.map((entry) => entry.text).join('\n');
  const full = entries.length > 0
    ? `${opening}\n${lead}${body}\n${closing}`
    : `${opening}\n${summaryElement}\n${closing}`;
  if (maxChars <= 0 || full.length <= maxChars) return { prefix: full };

  const truncatedMinimum = `${opening}\n${TRUNCATION_ELEMENT}\n${closing}`;
  if (truncatedMinimum.length > maxChars) {
    throw new RangeError(`Carried-context budget must be at least ${truncatedMinimum.length} characters`);
  }

  // The summary is never dropped: it is the only representation of everything
  // older than the spine.
  const available = Math.max(0, maxChars - opening.length - closing.length - 2 - lead.length);
  const pinnedFrom = Math.max(0, turns.length - RECENT_TURNS_VERBATIM);
  const admitted = new Set<ProjectedEntry>();
  // The asks come first, ahead of even the pinned turns. They are the irreducible
  // floor and they are cheap; a single recent turn carrying forty commands would
  // otherwise consume the whole budget and strand every request that produced it.
  const asks = admitLevel(
    entries,
    0,
    admitted,
    TRUNCATION_ELEMENT.length,
    available,
    Number.POSITIVE_INFINITY,
    true,
  );
  const pinned = admitPinnedTurns(entries, pinnedFrom, turns.length, admitted, asks.used, available);
  // The ladder covers every turn the pin did not take, so a chat whose newest
  // turns are too large to pin still gets the rest of its history laddered.
  const used = runLadder(entries, pinned.admittedFrom, admitted, pinned.used, available);

  const selected = entries.filter((entry) => admitted.has(entry));
  if (selected.length === 0) {
    const fitted = entries.at(-1)!.refit(available - used - 1);
    if (fitted) selected.push({ ...entries.at(-1)!, text: fitted });
  }
  return {
    prefix: `${opening}\n${lead}${[TRUNCATION_ELEMENT, ...selected.map((entry) => entry.text)].join('\n')}\n${closing}`,
  };
}

// Retained for callers that want the injection ceiling without naming it.
export function renderCarriedContext(
  messages: readonly ChatMessage[],
  options: { readonly maxChars?: number } = {},
): CarriedContext | null {
  return createCarryoverTranscript(messages, options.maxChars ?? CARRYOVER_INJECTION_MAX_CHARS);
}

// Admits the newest turns whole. When even those overflow, drops them oldest
// first so the turn the next agent continues from always survives.
function admitPinnedTurns(
  entries: readonly ProjectedEntry[],
  pinnedFrom: number,
  turnCount: number,
  admitted: Set<ProjectedEntry>,
  used: number,
  available: number,
): { readonly used: number; readonly admittedFrom: number } {
  for (let earliest = pinnedFrom; earliest < turnCount; earliest += 1) {
    const candidates = entries.filter((entry) => entry.turn >= earliest && !admitted.has(entry));
    const cost = candidates.reduce((total, entry) => total + 1 + entry.text.length, 0);
    if (used + cost <= available) {
      for (const entry of candidates) admitted.add(entry);
      return { used: used + cost, admittedFrom: earliest };
    }
  }
  return { used, admittedFrom: turnCount };
}

// Admits one ladder class in full when it fits, otherwise newest-first until the
// budget is spent. `complete` tells the ladder whether to continue to the next
// class or stop, so a cheaper later class never displaces a more valuable one.
function admitLevel(
  entries: readonly ProjectedEntry[],
  level: number,
  admitted: Set<ProjectedEntry>,
  used: number,
  available: number,
  turnLimit = Number.POSITIVE_INFINITY,
  pinOldest = false,
): { readonly used: number; readonly complete: boolean } {
  const candidates = entries.filter((entry) => (
    entry.turn < turnLimit && entry.level === level && !admitted.has(entry)
  ));
  const cost = candidates.reduce((sum, entry) => sum + 1 + entry.text.length, 0);
  if (used + cost <= available) {
    for (const entry of candidates) admitted.add(entry);
    return { used: used + cost, complete: true };
  }
  let total = used;
  // The asks are the one class where the oldest entry is reserved before the
  // newest-first fill: a chat that outgrows the budget still states the
  // objective it started from, and the requests lost come from the middle.
  const oldest = pinOldest ? candidates[0] : undefined;
  if (oldest && total + 1 + oldest.text.length <= available) {
    admitted.add(oldest);
    total += 1 + oldest.text.length;
  }
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    if (admitted.has(candidates[index])) continue;
    const entryCost = 1 + candidates[index].text.length;
    if (total + entryCost > available) break;
    admitted.add(candidates[index]);
    total += entryCost;
  }
  return { used: total, complete: false };
}

// Admits older turns one class at a time. A level that fits entirely is taken
// whole; the first level that does not is filled newest-first and ends the pass,
// so a cheaper later class never displaces a more valuable earlier one.
function runLadder(
  entries: readonly ProjectedEntry[],
  turnLimit: number,
  admitted: Set<ProjectedEntry>,
  used: number,
  available: number,
): number {
  let total = used;
  for (let level = 0; level <= LONG_TAIL_LEVEL; level += 1) {
    const outcome = admitLevel(entries, level, admitted, total, available, turnLimit);
    total = outcome.used;
    if (!outcome.complete) break;
  }
  return total;
}

// A turn is a user message and the activity that follows it, up to the next user
// message. Leading activity with no user message forms its own turn.
function groupIntoTurns(messages: readonly ChatMessage[]): ChatMessage[][] {
  const turns: ChatMessage[][] = [];
  for (const message of messages) {
    if (message.type === 'user-message' || turns.length === 0) turns.push([message]);
    else turns[turns.length - 1].push(message);
  }
  return turns;
}

// Collapses a turn's file access into one element per kind. Ten edits of one file
// are one fact, not ten, and the ordering inside a burst carries little meaning;
// keeping the aggregate inside the turn preserves which request caused which
// change, which is the part that does.
function renderTurn(turn: readonly ChatMessage[], turnIndex: number): ProjectedEntry[] {
  const entries: ProjectedEntry[] = [];
  const reads: string[] = [];
  const edits = new Map<string, number>();
  for (const message of turn) {
    // A tool that names no path falls through to its own element rather than
    // being aggregated into nothing: Codex reports file changes as a `changes[]`
    // array with no top-level path, and swallowing those would lose the durable
    // state this aggregation exists to carry.
    if (AGGREGATED_READS.has(message.type)) {
      const path = toolFilePath(message);
      if (path) {
        if (!reads.includes(path)) reads.push(path);
        continue;
      }
    } else if (AGGREGATED_EDITS.has(message.type)) {
      const paths = editedPaths(message);
      if (paths.length > 0) {
        for (const path of paths) edits.set(path, (edits.get(path) ?? 0) + 1);
        continue;
      }
    }
    const text = renderMessageElement(message);
    if (text) {
      entries.push({
        level: levelOf(message.type),
        turn: turnIndex,
        text,
        refit: (maximum) => renderMessageElement(message, maximum),
      });
    }
  }
  if (reads.length > 0) entries.push(aggregateEntry('files-read', reads.join(', '), READ_LEVEL, turnIndex));
  if (edits.size > 0) {
    const rendered = [...edits].map(([path, count]) => (count > 1 ? `${path} (${count} edits)` : path));
    entries.push(aggregateEntry('files-edited', rendered.join(', '), EDIT_LEVEL, turnIndex));
  }
  return entries;
}

function aggregateEntry(name: string, content: string, level: number, turn: number): ProjectedEntry {
  const open = `    <${name}>`;
  const close = `</${name}>`;
  return {
    level,
    turn,
    text: fitElement(open, content, close, Number.POSITIVE_INFINITY),
    refit: (maximum) => fitElement(open, content, close, maximum),
  };
}

function levelOf(type: string): number {
  const index = LADDER.findIndex((classes) => classes.includes(type));
  return index === -1 ? LONG_TAIL_LEVEL : index;
}

function toolFilePath(message: ChatMessage): string {
  return 'filePath' in message && typeof message.filePath === 'string' ? message.filePath : '';
}

// Edits carry their paths one of two ways. Claude sets `filePath`; the Codex
// app-server sets `changes[]` and leaves `filePath` undefined
// (server-agents/codex/src/agents/codex/app-server/converter.ts).
function editedPaths(message: ChatMessage): string[] {
  const direct = toolFilePath(message);
  if (direct) return [direct];
  if (!('changes' in message) || !Array.isArray(message.changes)) return [];
  return message.changes
    .map((change) => (
      change && typeof change.path === 'string' ? change.path : ''
    ))
    .filter(Boolean);
}

export function createNativeSeedReceipt(input: {
  readonly agentSessionId: string;
  readonly placement: NativeSeedReceipt['placement'];
  readonly prefix: string;
  readonly format?: NativeSeedReceipt['format'];
}): NativeSeedReceipt {
  if (!input.agentSessionId) throw new Error('Native seed receipt session ID is required');
  return {
    agentSessionId: input.agentSessionId,
    placement: input.placement,
    format: input.format ?? 'v3-xml',
    codeUnitLength: input.prefix.length,
    sha256: sha256(input.prefix),
  };
}

export function receiptForCarriedContext(
  carriedContext: CarriedContext | null,
  agentSessionId: string,
  placement: NativeSeedReceipt['placement'] = 'user-prefix',
): NativeSeedReceipt | null {
  return carriedContext
    ? createNativeSeedReceipt({
        agentSessionId,
        placement,
        prefix: carriedContext.prefix,
      })
    : null;
}

export function retargetNativeSeedReceipt(
  receipt: NativeSeedReceipt | null,
  agentSessionId: string,
): NativeSeedReceipt | null {
  if (!receipt) return null;
  if (!agentSessionId) throw new Error('Native seed receipt session ID is required');
  return { ...receipt, agentSessionId };
}

export function retargetNativeSeedReceiptIfPreserved(
  receipt: NativeSeedReceipt | null,
  agentSessionId: string,
  messages: readonly ChatMessage[],
): NativeSeedReceipt | null {
  if (!receipt) return null;
  const firstUserMessage = messages.find((message) => message.type === 'user-message');
  if (!(firstUserMessage instanceof UserMessage)) return null;
  const prefix = firstUserMessage.content.slice(0, receipt.codeUnitLength);
  if (prefix.length !== receipt.codeUnitLength || sha256(prefix) !== receipt.sha256) return null;
  if (
    receipt.placement === 'provider-context'
    && firstUserMessage.content.length !== receipt.codeUnitLength
  ) return null;
  return retargetNativeSeedReceipt(receipt, agentSessionId);
}

export function parseNativeSeedReceipt(value: unknown): NativeSeedReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const receipt = value as Record<string, unknown>;
  if (typeof receipt.agentSessionId !== 'string' || !receipt.agentSessionId) return null;
  if (receipt.placement !== 'user-prefix' && receipt.placement !== 'provider-context') return null;
  if (
    receipt.format !== 'v3-xml'
    && receipt.format !== 'v2-xml'
    && receipt.format !== 'v1-marker'
    && receipt.format !== 'legacy-v0'
  ) return null;
  if (!Number.isSafeInteger(receipt.codeUnitLength) || Number(receipt.codeUnitLength) < 0) return null;
  if (typeof receipt.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.sha256)) return null;
  return {
    agentSessionId: receipt.agentSessionId,
    placement: receipt.placement,
    format: receipt.format,
    codeUnitLength: Number(receipt.codeUnitLength),
    sha256: receipt.sha256,
  };
}

export function sanitizeRecordedCarriedContext(input: {
  readonly messages: readonly ChatMessage[];
  readonly receipt: NativeSeedReceipt | null;
  readonly agentSessionId: string | null;
}): SanitizeCarriedContextResult {
  const { messages, receipt } = input;
  if (!receipt) return { kind: 'not-applicable', messages };
  if (!input.agentSessionId || receipt.agentSessionId !== input.agentSessionId) {
    return mismatch(messages, 'Seed receipt does not name the current native session');
  }
  if (receipt.placement === 'provider-context') return { kind: 'not-applicable', messages };

  const index = messages.findIndex((message) => message.type === 'user-message');
  if (index === -1) return { kind: 'absent', messages };
  const original = messages[index] as UserMessage;
  const prefix = original.content.slice(0, receipt.codeUnitLength);
  if (prefix.length === receipt.codeUnitLength && sha256(prefix) === receipt.sha256) {
    const next = messages.slice();
    next[index] = new UserMessage(
      original.timestamp,
      original.content.slice(receipt.codeUnitLength),
      original.images,
      original.metadata,
    );
    return { kind: 'stripped-exact', messages: next };
  }

  if (receipt.format !== 'legacy-v0' && original.content.startsWith(CARRIED_CONTEXT_OPEN_PREFIX)) {
    return mismatch(messages, 'Recorded carried-context XML was rewritten');
  }
  return { kind: 'absent', messages };
}

// Retains the pre-v2 helpers only for importing legacy provider transcripts.
export function renderTranscriptSeed(
  messages: ChatMessage[],
  options: { maxChars?: number; fromAgentLabel?: string } = {},
): string {
  const lines = messages.map(renderLegacyMessageLine).filter(Boolean);
  if (lines.length === 0) return '';
  const preamble = `The following is a prior conversation with ${options.fromAgentLabel || 'another assistant'}. Continue it.`;
  const { kept, truncated } = capLegacyLines(lines, options.maxChars ?? LEGACY_SEED_MAX_CHARS);
  return [
    preamble,
    SEED_CONTEXT_OPEN,
    ...(truncated ? ['[earlier turns truncated]', ...kept] : kept),
    SEED_CONTEXT_CLOSE,
  ].join('\n');
}

export function stripTranscriptSeed(userText: string): string {
  const openIndex = userText.indexOf(SEED_CONTEXT_OPEN);
  if (openIndex === -1) return userText;
  const prefix = userText.slice(0, openIndex);
  if (prefix.trim().length > 0 && !prefix.trimEnd().endsWith('Continue it.')) return userText;
  const closeIndex = userText.indexOf(SEED_CONTEXT_CLOSE, openIndex);
  if (closeIndex === -1) return userText;
  return userText.slice(closeIndex + SEED_CONTEXT_CLOSE.length).replace(/^\s+/, '');
}

export function stripFirstUserSeed(messages: ChatMessage[]): ChatMessage[] {
  const index = messages.findIndex((message) => message.type === 'user-message');
  if (index === -1) return messages;
  const original = messages[index] as UserMessage;
  const stripped = stripTranscriptSeed(original.content);
  if (stripped === original.content) return messages;
  const next = messages.slice();
  next[index] = new UserMessage(original.timestamp, stripped, original.images, original.metadata);
  return next;
}

// Tool results are never projected. They are reproducible by the agent that
// inherits the work, and often should be reproduced rather than trusted, since a
// file's contents at handoff time may already be stale. Their durable meaning is
// normally restated in the assistant's next message, which the ladder admits
// before any tool class.
export function isProjectableMessage(message: ChatMessage): boolean {
  return message.type === 'user-message'
    || message.type === 'assistant-message'
    || isToolUseMessage(message);
}

function renderMessageElement(message: ChatMessage, maximum = Number.POSITIVE_INFINITY): string {
  if (isToolUseMessage(message)) {
    const detail = toolSummary(message);
    return fitElement(
      '    <assistant><tool-use>',
      detail ? `${toolName(message)}: ${detail}` : toolName(message),
      '</tool-use></assistant>',
      maximum,
    );
  }
  switch (message.type) {
    case 'user-message':
      return fitElement('    <user>', boundedCollapse(message.content), '</user>', maximum);
    case 'assistant-message':
      return fitElement('    <assistant>', boundedCollapse(message.content), '</assistant>', maximum);
    default:
      return '';
  }
}

function fitElement(open: string, content: string, close: string, maximum: number): string {
  const overhead = open.length + close.length;
  if (maximum < overhead) return '';
  const escaped = escapeXml(content);
  if (overhead + escaped.length <= maximum) return `${open}${escaped}${close}`;
  const suffix = '...';
  if (maximum < overhead + suffix.length) return '';
  const codePoints = Array.from(content);
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = escapeXml(codePoints.slice(0, middle).join(''));
    if (overhead + candidate.length + suffix.length <= maximum) low = middle;
    else high = middle - 1;
  }
  return `${open}${escapeXml(codePoints.slice(0, low).join(''))}${suffix}${close}`;
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function renderLegacyMessageLine(message: ChatMessage): string {
  if (isToolUseMessage(message)) {
    return `Assistant used ${toolName(message)}: ${legacyToolSummary(message)}`;
  }
  switch (message.type) {
    case 'user-message': return `User: ${legacyCollapse(message.content)}`;
    case 'assistant-message': return `Assistant: ${legacyCollapse(message.content)}`;
    case 'tool-result': return `Tool result: ${legacyCollapse(stringifyLegacyToolResult(message.content))}`;
    default: return '';
  }
}

function capLegacyLines(lines: string[], maxChars: number): { kept: string[]; truncated: boolean } {
  if (maxChars <= 0) return { kept: lines, truncated: false };
  const kept: string[] = [];
  let total = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const cost = line.length + (kept.length > 0 ? 1 : 0);
    if (total + cost > maxChars && kept.length > 0) return { kept, truncated: true };
    kept.unshift(line);
    total += cost;
  }
  return { kept, truncated: false };
}

function toolName(message: ToolUseChatMessage): string {
  return message.type.replace(/-tool-use$/, '');
}

function toolSummary(message: ToolUseChatMessage): string {
  return truncate(boundedCollapse(extractToolDetail(message)), TOOL_SUMMARY_MAX_CHARS);
}

// Frozen alongside `stringifyLegacyToolResult` and for the same reason: the
// legacy renderer reproduces bytes older releases injected, and the v3 migration
// hashes that output to strip a legacy seed. Teaching it the tool cases
// `extractToolDetail` gained would change `Assistant used exec: ` into
// `Assistant used exec: pytest -q tests/`, so an unmigrated workspace holding any
// of those tools would fail its exact-prefix strip and archive a nested seed.
function legacyToolSummary(message: ToolUseChatMessage): string {
  return truncate(legacyCollapse(extractLegacyToolDetail(message)), TOOL_SUMMARY_MAX_CHARS);
}

function extractLegacyToolDetail(message: ToolUseChatMessage): string {
  switch (message.type) {
    case 'bash-tool-use': return message.description || message.command;
    case 'read-tool-use':
    case 'write-tool-use': return message.filePath;
    case 'edit-tool-use':
    case 'apply-patch-tool-use': return message.filePath ?? '';
    case 'list-tool-use': return message.path ?? '';
    case 'grep-tool-use':
    case 'glob-tool-use': return message.pattern ?? '';
    case 'web-search-tool-use': return message.query;
    case 'web-fetch-tool-use': return message.url;
    case 'task-tool-use': return message.description || message.prompt || message.subagentType || '';
    case 'external-tool-use': return message.name;
    case 'mcp-tool-use': return `${message.server}/${message.tool}`;
    case 'unknown-tool-use': return message.rawName;
    default: return '';
  }
}

function extractToolDetail(message: ToolUseChatMessage): string {
  switch (message.type) {
    case 'bash-tool-use': return message.description || message.command;
    // Codex expresses shell work as exec rather than bash; without this the
    // busiest tool in a Codex transcript carried only its own name.
    case 'exec-tool-use': return message.code;
    case 'write-stdin-tool-use': return stringifyToolPayload(message.input);
    case 'read-tool-use':
    case 'write-tool-use': return message.filePath;
    case 'edit-tool-use':
    case 'apply-patch-tool-use': return message.filePath ?? '';
    case 'list-tool-use': return message.path ?? '';
    case 'grep-tool-use':
    case 'glob-tool-use': return message.pattern ?? '';
    case 'web-search-tool-use': return message.query;
    case 'web-fetch-tool-use': return message.url;
    case 'task-tool-use': return message.description || message.prompt || message.subagentType || '';
    case 'codex-subagent-tool-use': return message.action;
    case 'update-plan-tool-use':
    case 'todo-write-tool-use': return summarizeTodos(message.todos);
    case 'ask-user-question-tool-use':
      return message.title || message.questions.map((prompt) => prompt.prompt).join('; ');
    case 'wait-tool-use': return message.executionId;
    case 'external-tool-use': return message.name;
    case 'mcp-tool-use': return `${message.server}/${message.tool}`;
    case 'unknown-tool-use': return message.rawName;
    default: return '';
  }
}

function summarizeTodos(todos: readonly TodoItem[] | undefined): string {
  if (!todos?.length) return '';
  const active = todos.find((todo) => todo.status === 'in_progress') ?? todos[0];
  return `${todos.length} item(s), current: ${active.content}`;
}

// Providers wrap payloads differently: Claude nests text under `items`, Codex
// carries a `raw` string, and shells report `stdout`. Without these the summary
// budget is spent on serialized envelope keys instead of the actual content.
function stringifyToolPayload(content: Record<string, unknown>): string {
  const direct = content.text ?? content.output ?? content.content ?? content.stdout ?? content.raw;
  if (typeof direct === 'string') return direct;
  if (Array.isArray(content.items)) {
    const text = content.items
      .map((item) => (isTextItem(item) ? item.text : ''))
      .filter(Boolean)
      .join(' ');
    if (text) return text;
  }
  try {
    return JSON.stringify(content);
  } catch {
    return '';
  }
}

// Deliberately not `stringifyToolPayload`. The legacy renderer reproduces the
// exact bytes older releases injected, and the migration hashes that output to
// strip a legacy seed; widening the probe here would change those bytes and turn
// `stripped-exact` into `absent` for every v3 workspace still being migrated.
function stringifyLegacyToolResult(content: Record<string, unknown>): string {
  const text = content.text ?? content.output ?? content.content ?? content.stdout;
  if (typeof text === 'string') return text;
  try {
    return JSON.stringify(content);
  } catch {
    return '';
  }
}

function isTextItem(value: unknown): value is { readonly text: string } {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { text?: unknown }).text === 'string';
}

// The pre-migration renderer collapsed the whole string with no length bound.
// `boundedCollapse` slices to 8,000 code units first, which changes the bytes for
// any legacy message longer than that — and those bytes are what the v3 migration
// hashes to strip a legacy seed. Frozen here for the same reason as
// `stringifyLegacyToolResult` and `extractLegacyToolDetail`.
function legacyCollapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function boundedCollapse(value: string): string {
  return value.slice(0, MESSAGE_PROJECTION_MAX_CHARS * 2).replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

function mismatch(
  messages: readonly ChatMessage[],
  reason: string,
): SanitizeCarriedContextResult {
  return { kind: 'mismatch', messages, reason };
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}
