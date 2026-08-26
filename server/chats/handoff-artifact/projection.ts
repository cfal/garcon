import {
  isHandoffSummaryNoticeDetail,
  isToolUseMessage,
  type ChatMessage,
} from '../../../common/chat-types.js';
import {
  projectionPriorityLevel,
  selectPrioritizedProjection,
  type PrioritizedProjectionEntry,
} from '../../../common/transcript-projection.js';
import { projectToolUseSummary } from '../../../common/transcript-seed.js';
import type { TranscriptExportEntry } from '../../ledger/export-fold.js';
import {
  redactDataUrl,
  textSafe,
  xmlAttribute,
  xmlText,
} from '../transcript-export/values.js';
import type {
  HandoffArtifactAttribute,
  HandoffArtifactDocumentNode,
  HandoffArtifactSelection,
  HandoffArtifactSourceEntry,
  RenderedHandoffArtifactEntry,
} from './model.js';

export const HANDOFF_ARTIFACT_BODY_MAX_CHARS = 4_000;

interface ProjectionAdapter extends PrioritizedProjectionEntry {
  readonly source: HandoffArtifactSourceEntry;
  readonly fullXml: string;
}

export function handoffArtifactEntries(
  entries: readonly TranscriptExportEntry[],
  signal?: AbortSignal,
): HandoffArtifactSourceEntry[] {
  const source: HandoffArtifactSourceEntry[] = [];
  let turn = -1;
  for (let index = 0; index < entries.length; index += 1) {
    if (index % 256 === 0) signal?.throwIfAborted();
    const entry = entries[index];
    if (entry.kind !== 'message') continue;
    const message = entry.message;
    if (!isEligibleMessage(message)) continue;
    if (message.type === 'user-message' || turn < 0) turn += 1;
    const projected = projectEntry(entry.ordinal, turn, message);
    if (projected) source.push(projected);
  }
  signal?.throwIfAborted();
  return source;
}

export function selectHandoffArtifactEntries(input: {
  readonly entries: readonly HandoffArtifactSourceEntry[];
  readonly maximumCost: number;
  readonly cost: (text: string) => number;
}): HandoffArtifactSelection {
  const adapters = input.entries.map((source): ProjectionAdapter => {
    const fullXml = renderHandoffArtifactEntry(source);
    return {
      source,
      fullXml,
      level: source.level,
      turn: source.turn,
      text: fullXml,
      refit: (maximumCost, cost) => refitHandoffArtifactEntry(source, maximumCost, cost),
    };
  });
  const projection = input.maximumCost <= 0
    ? null
    : selectPrioritizedProjection({
      entries: adapters,
      turnCount: input.entries.length === 0 ? 0 : input.entries.at(-1)!.turn + 1,
      maximumCost: input.maximumCost,
      truncationMarkerCost: input.cost('    <gap omitted-entries="1"/>\n'),
      cost: (text) => input.cost(`${text}\n`),
      recentTurnsVerbatim: 3,
    });
  const selected = projection?.selected ?? [];
  const selectedByOrdinal = new Map<number, RenderedHandoffArtifactEntry>();
  for (const entry of selected) {
    selectedByOrdinal.set(entry.source.ordinal, {
      source: entry.source,
      xml: entry.text,
      abridged: entry.source.abridged || entry.text !== entry.fullXml,
    });
  }
  const nodes = interleaveGaps(input.entries, selectedByOrdinal);
  const includedEntryCount = selectedByOrdinal.size;
  const omittedEntryCount = input.entries.length - includedEntryCount;
  const abridgedEntryCount = [...selectedByOrdinal.values()]
    .filter((entry) => entry.abridged).length;
  const gapCount = nodes.filter((node) => node.kind === 'gap').length;
  return {
    nodes,
    admissionCost: projection?.admissionCost ?? 0,
    includedEntryCount,
    omittedEntryCount,
    abridgedEntryCount,
    gapCount,
    truncated: omittedEntryCount > 0 || abridgedEntryCount > 0,
  };
}

export function renderHandoffArtifactEntry(
  source: HandoffArtifactSourceEntry,
  body = source.body,
  abridged = source.abridged,
): string {
  const attributes = [
    `ordinal="${source.ordinal}"`,
    ...source.attributes.map(({ name, value }) => `${name}="${xmlAttribute(value)}"`),
    ...(abridged ? ['abridged="true"'] : []),
  ].join(' ');
  if (body === null) return `    <${source.tag} ${attributes}/>`;
  return [
    `    <${source.tag} ${attributes}>`,
    `      <text>${xmlText(body)}</text>`,
    `    </${source.tag}>`,
  ].join('\n');
}

function isEligibleMessage(message: ChatMessage): boolean {
  return message.type === 'user-message'
    || message.type === 'assistant-message'
    || message.type === 'compaction'
    || message.type === 'agent-switch'
    || isToolUseMessage(message)
    || (message.type === 'transcript-notice'
      && isHandoffSummaryNoticeDetail(message.detail));
}

function projectEntry(
  ordinal: number,
  turn: number,
  message: ChatMessage,
): HandoffArtifactSourceEntry | null {
  if (isToolUseMessage(message)) {
    const summary = projectToolUseSummary(message);
    const body = artifactBody(summary.text);
    return sourceEntry({
      ordinal,
      turn,
      level: projectionPriorityLevel(message.type),
      tag: 'tool-call',
      attributes: [{ name: 'type', value: message.type }],
      body: body.text || null,
      abridged: summary.abridged || body.abridged,
    });
  }
  switch (message.type) {
    case 'user-message': {
      const body = artifactBody(message.content);
      return sourceEntry({
        ordinal,
        turn,
        level: projectionPriorityLevel(message.type),
        tag: 'user',
        body: body.text,
        abridged: body.abridged || (message.images?.length ?? 0) > 0,
      });
    }
    case 'assistant-message': {
      const body = artifactBody(message.content);
      return sourceEntry({
        ordinal,
        turn,
        level: projectionPriorityLevel(message.type),
        tag: 'assistant',
        body: body.text,
        abridged: body.abridged,
      });
    }
    case 'compaction': {
      const body = artifactBody(message.summary);
      return sourceEntry({
        ordinal,
        turn,
        level: projectionPriorityLevel('assistant-message'),
        tag: 'compaction',
        attributes: [{ name: 'trigger', value: message.trigger }],
        body: body.text,
        abridged: body.abridged,
      });
    }
    case 'agent-switch':
      return sourceEntry({
        ordinal,
        turn,
        level: projectionPriorityLevel('assistant-message'),
        tag: 'handoff',
        attributes: [
          { name: 'from-agent', value: message.fromAgentId },
          { name: 'to-agent', value: message.toAgentId },
          ...(message.fromModel === undefined
            ? []
            : [{ name: 'from-model', value: message.fromModel }]),
          ...(message.toModel === undefined
            ? []
            : [{ name: 'to-model', value: message.toModel }]),
        ],
        body: null,
        abridged: false,
      });
    case 'transcript-notice': {
      if (!isHandoffSummaryNoticeDetail(message.detail)) return null;
      const body = artifactBody(message.content);
      return sourceEntry({
        ordinal,
        turn,
        level: projectionPriorityLevel('assistant-message'),
        tag: 'notice',
        attributes: [{ name: 'type', value: 'handoff-summary' }],
        body: body.text,
        abridged: body.abridged,
      });
    }
    default:
      return null;
  }
}

function sourceEntry(input: {
  readonly ordinal: number;
  readonly level: number;
  readonly turn: number;
  readonly tag: HandoffArtifactSourceEntry['tag'];
  readonly attributes?: readonly HandoffArtifactAttribute[];
  readonly body: string | null;
  readonly abridged: boolean;
}): HandoffArtifactSourceEntry {
  return { ...input, attributes: input.attributes ?? [] };
}

function artifactBody(value: string): { readonly text: string; readonly abridged: boolean } {
  const redacted = redactDataUrl(value);
  const safe = textSafe(redacted);
  const capped = codeUnitSafePrefix(safe, HANDOFF_ARTIFACT_BODY_MAX_CHARS);
  return {
    text: capped.text,
    abridged: redacted !== value || capped.abridged,
  };
}

function codeUnitSafePrefix(
  value: string,
  maximum: number,
): { readonly text: string; readonly abridged: boolean } {
  if (value.length <= maximum) return { text: value, abridged: false };
  const suffix = '...';
  const codePoints = Array.from(value);
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (codePoints.slice(0, middle).join('').length + suffix.length <= maximum) low = middle;
    else high = middle - 1;
  }
  return { text: `${codePoints.slice(0, low).join('')}${suffix}`, abridged: true };
}

function refitHandoffArtifactEntry(
  source: HandoffArtifactSourceEntry,
  maximumCost: number,
  cost: (text: string) => number,
): string {
  const full = renderHandoffArtifactEntry(source);
  if (cost(full) <= maximumCost) return full;
  if (source.body === null) return '';
  const suffix = '...';
  if (cost(renderHandoffArtifactEntry(source, suffix, true)) > maximumCost) return '';
  const codePoints = Array.from(source.body);
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${codePoints.slice(0, middle).join('')}${suffix}`;
    if (cost(renderHandoffArtifactEntry(source, candidate, true)) <= maximumCost) low = middle;
    else high = middle - 1;
  }
  return renderHandoffArtifactEntry(
    source,
    `${codePoints.slice(0, low).join('')}${suffix}`,
    true,
  );
}

function interleaveGaps(
  source: readonly HandoffArtifactSourceEntry[],
  selected: ReadonlyMap<number, RenderedHandoffArtifactEntry>,
): HandoffArtifactDocumentNode[] {
  const nodes: HandoffArtifactDocumentNode[] = [];
  let index = 0;
  let previousOrdinal: number | null = null;
  while (index < source.length) {
    const entry = selected.get(source[index].ordinal);
    if (entry) {
      nodes.push({ kind: 'entry', entry });
      previousOrdinal = entry.source.ordinal;
      index += 1;
      continue;
    }
    const omittedStart = index;
    while (index < source.length && !selected.has(source[index].ordinal)) index += 1;
    const nextOrdinal = index < source.length ? source[index].ordinal : null;
    nodes.push({
      kind: 'gap',
      gap: {
        afterOrdinal: previousOrdinal,
        beforeOrdinal: nextOrdinal,
        omittedEntryCount: index - omittedStart,
      },
    });
  }
  return nodes;
}
