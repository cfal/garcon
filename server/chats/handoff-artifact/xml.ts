import { usableHandoffTokenBudget } from '../../../common/handoff-sizing.js';
import {
  estimateHandoffTokens,
  fitEstimatedTokenDocument,
} from '../handoff-token-budget.js';
import { xmlAttribute } from '../transcript-export/values.js';
import { selectHandoffArtifactEntries } from './projection.js';
import type {
  HandoffArtifactChatMetadata,
  HandoffArtifactGap,
  HandoffArtifactSelection,
  HandoffArtifactSourceEntry,
  RenderedHandoffArtifact,
} from './model.js';

const ESTIMATED_TOKEN_METADATA_MAX_PASSES = 4;

export interface HandoffArtifactXmlInput {
  readonly chat: HandoffArtifactChatMetadata;
  readonly transcriptViewId: string;
  readonly lastOrdinal: number;
  readonly contextWindowTokens: number;
  readonly usableTokenBudget: number;
  readonly totalEntryCount: number;
  readonly selection: HandoffArtifactSelection;
}

export function renderFittedHandoffArtifact(input: {
  readonly chat: HandoffArtifactChatMetadata;
  readonly transcriptViewId: string;
  readonly lastOrdinal: number;
  readonly contextWindowTokens: number;
  readonly entries: readonly HandoffArtifactSourceEntry[];
  readonly signal?: AbortSignal;
}): RenderedHandoffArtifact | null {
  const usableTokenBudget = usableHandoffTokenBudget(input.contextWindowTokens);
  const fixedSelection = selectHandoffArtifactEntries({
    entries: input.entries,
    maximumCost: 0,
    cost: estimateHandoffTokens,
  });
  const fixedFrame = renderHandoffArtifactXml({
    ...input,
    usableTokenBudget,
    totalEntryCount: input.entries.length,
    selection: fixedSelection,
  });
  const fitted = fitEstimatedTokenDocument({
    usableTokens: usableTokenBudget,
    fixedFrameTokens: fixedFrame.estimatedTokens,
    minimumEntryBudgetTokens: 0,
    render(entryBudgetTokens) {
      input.signal?.throwIfAborted();
      const selection = selectHandoffArtifactEntries({
        entries: input.entries,
        maximumCost: entryBudgetTokens,
        cost: estimateHandoffTokens,
      });
      const rendered = renderHandoffArtifactXml({
        ...input,
        usableTokenBudget,
        totalEntryCount: input.entries.length,
        selection,
      });
      return { selection, rendered };
    },
    document: ({ rendered }) => rendered.document,
  });
  if (!fitted) return null;
  const { selection, rendered } = fitted.value;
  if (rendered.estimatedTokens !== fitted.estimatedTokens) {
    throw new Error('Handoff artifact estimate diverged from the fitted document');
  }
  return {
    transcriptViewId: input.transcriptViewId,
    lastOrdinal: input.lastOrdinal,
    contextWindowTokens: input.contextWindowTokens,
    usableTokenBudget,
    estimatedTokens: rendered.estimatedTokens,
    totalEntryCount: input.entries.length,
    includedEntryCount: selection.includedEntryCount,
    omittedEntryCount: selection.omittedEntryCount,
    abridgedEntryCount: selection.abridgedEntryCount,
    gapCount: selection.gapCount,
    truncated: selection.truncated,
    document: rendered.document,
    fitCorrectionPasses: fitted.correctionPasses,
    metadataPasses: rendered.metadataPasses,
  };
}

export function renderHandoffArtifactXml(input: HandoffArtifactXmlInput): {
  readonly document: string;
  readonly estimatedTokens: number;
  readonly metadataPasses: number;
} {
  let declaredEstimate = 0;
  for (let pass = 0; pass < ESTIMATED_TOKEN_METADATA_MAX_PASSES; pass += 1) {
    const document = renderWithEstimate(input, declaredEstimate);
    const estimatedTokens = estimateHandoffTokens(document);
    if (estimatedTokens === declaredEstimate) {
      return { document, estimatedTokens, metadataPasses: pass + 1 };
    }
    declaredEstimate = estimatedTokens;
  }
  throw new Error('Handoff artifact token metadata did not converge');
}

function renderWithEstimate(input: HandoffArtifactXmlInput, estimatedTokens: number): string {
  const { selection } = input;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<handoff-artifact version="1" chat-id="${xmlAttribute(input.chat.id)}" transcript-view-id="${xmlAttribute(input.transcriptViewId)}" last-ordinal="${input.lastOrdinal}" context-window-tokens="${input.contextWindowTokens}" usable-token-budget="${input.usableTokenBudget}" estimated-tokens="${estimatedTokens}" total-entries="${input.totalEntryCount}" included-entries="${selection.includedEntryCount}" omitted-entries="${selection.omittedEntryCount}" abridged-entries="${selection.abridgedEntryCount}" gaps="${selection.gapCount}" truncated="${selection.truncated}">`,
    `  <chat title="${xmlAttribute(input.chat.title)}" agent="${xmlAttribute(input.chat.agentId)}"${input.chat.model === null ? '' : ` model="${xmlAttribute(input.chat.model)}"`}/>`,
  ];
  if (selection.nodes.length === 0) {
    lines.push('  <entries/>');
  } else {
    lines.push('  <entries>');
    for (const node of selection.nodes) {
      lines.push(node.kind === 'entry' ? node.entry.xml : renderGap(node.gap));
    }
    lines.push('  </entries>');
  }
  lines.push('</handoff-artifact>');
  return `${lines.join('\n')}\n`;
}

function renderGap(gap: HandoffArtifactGap): string {
  const attributes = [
    ...(gap.afterOrdinal === null ? [] : [`after-ordinal="${gap.afterOrdinal}"`]),
    ...(gap.beforeOrdinal === null ? [] : [`before-ordinal="${gap.beforeOrdinal}"`]),
    `omitted-entries="${gap.omittedEntryCount}"`,
  ].join(' ');
  return `    <gap ${attributes}/>`;
}
