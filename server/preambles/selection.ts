import { renderPreamblePrefix } from '../../common/preamble-prefix.js';
import { CHAT_ID_LENGTH } from '../../common/chat-id.js';
import {
  PREAMBLE_COMBINED_MAX_LENGTH,
  PREAMBLE_FILE_CONTEXT_SEPARATOR,
  renderPreambleContent,
  type ChatPreambleSelection,
  type Preamble,
  type PreambleId,
  type PreambleSelectionProjection,
  type PreamblesSnapshot,
  type UnavailablePreambleSelectionReference,
} from '../../common/preambles.js';
import { DomainError } from '../lib/domain-error.js';
import { preambleRuleMatches } from './matching.js';

const CHAT_ID_VALIDATION_SAMPLE = '1'.repeat(CHAT_ID_LENGTH);

export const PREAMBLE_SELECTION_COMPOSITION_INVALID_MESSAGE =
  'Selected preambles can\u2019t be applied in this order. Reconfigure this chat\u2019s preambles and try again.';

function preambleScopeMatches(preamble: Preamble, canonicalProjectPath: string): boolean {
  return preamble.scope.type === 'global'
    || preamble.scope.rules.some((rule) => preambleRuleMatches(rule, canonicalProjectPath));
}

// Iterates the saved ID order against one catalog snapshot; filtering the
// catalog through the selection would preserve the wrong order.
export function resolvePreambleSelection(
  selection: ChatPreambleSelection,
  catalog: PreamblesSnapshot,
  canonicalProjectPath: string,
): {
  readonly eligible: readonly Preamble[];
  readonly unavailable: readonly UnavailablePreambleSelectionReference[];
} {
  const byId = new Map(catalog.preambles.map((preamble) => [preamble.id, preamble]));
  const eligible: Preamble[] = [];
  const unavailable: UnavailablePreambleSelectionReference[] = [];

  for (const id of selection.orderedPreambleIds) {
    const preamble = byId.get(id);
    if (!preamble) {
      unavailable.push({ id, reason: 'missing' });
    } else if (!preamble.enabled) {
      unavailable.push({ id, reason: 'disabled' });
    } else if (!preambleScopeMatches(preamble, canonicalProjectPath)) {
      unavailable.push({ id, reason: 'out-of-scope' });
    } else {
      eligible.push(structuredClone(preamble));
    }
  }
  return { eligible, unavailable };
}

export function projectPreambleSelection(
  selection: ChatPreambleSelection,
  catalog: PreamblesSnapshot,
  canonicalProjectPath: string,
): PreambleSelectionProjection {
  const resolved = resolvePreambleSelection(selection, catalog, canonicalProjectPath);
  return {
    catalogRevision: catalog.revision,
    eligiblePreambles: resolved.eligible.map(({ id, title }) => ({ id, title })),
    unavailable: resolved.unavailable.map((reference) => ({ ...reference })),
  };
}

// New-chat defaults: enabled, matching catalog IDs in catalog order.
export function defaultOrderedPreambleIds(
  catalog: PreamblesSnapshot,
  canonicalProjectPath: string,
): PreambleId[] {
  return catalog.preambles
    .filter((preamble) => preamble.enabled && preambleScopeMatches(preamble, canonicalProjectPath))
    .map((preamble) => preamble.id);
}

// Validates the exact currently eligible composition in selected order. The
// catalog-wide mutation validator proves only catalog order; chat-level
// reordering can reconstruct the reserved separator across individually valid
// entries, so every changed Save, explicit creation, and admission re-proves it.
export function assertPreambleSelectionComposition(
  chatId: string,
  eligible: readonly Preamble[],
): void {
  if (eligible.length === 0) return;
  const prefix = renderPreamblePrefix(eligible.map((preamble) =>
    renderPreambleContent(preamble.content, chatId)));
  if (
    prefix.includes(PREAMBLE_FILE_CONTEXT_SEPARATOR)
    || prefix.length > PREAMBLE_COMBINED_MAX_LENGTH
  ) {
    throw selectionCompositionInvalidError();
  }
}

export function selectionCompositionInvalidError(): DomainError {
  return new DomainError(
    'PREAMBLE_SELECTION_COMPOSITION_INVALID',
    PREAMBLE_SELECTION_COMPOSITION_INVALID_MESSAGE,
    422,
  );
}

// The two recoverable preamble admission errors: an affected prepared target is
// retained for reconfiguration, a queued entry is consumed with a failure, and
// the pending boundary survives both.
export function isRecoverablePreambleAdmissionError(
  error: unknown,
): error is DomainError {
  return error instanceof DomainError
    && (error.code === 'PREAMBLE_SELECTION_COMPOSITION_INVALID'
      || error.code === 'PREAMBLE_SLASH_COMMAND_BLOCKED');
}

// Resolves an explicit or defaulted creation selection against one catalog
// snapshot. Omitted IDs take enabled matching entries in catalog order; an
// explicit list, including empty, is stored exactly as supplied after its
// currently eligible composition is proven safe.
export function resolveNewChatPreambleSelection(input: {
  readonly catalog: PreamblesSnapshot;
  readonly canonicalProjectPath: string;
  readonly chatId: string;
  readonly orderedPreambleIds?: readonly PreambleId[];
}): ChatPreambleSelection {
  if (input.orderedPreambleIds === undefined) {
    return {
      revision: 0,
      orderedPreambleIds: defaultOrderedPreambleIds(input.catalog, input.canonicalProjectPath),
    };
  }
  const selection: ChatPreambleSelection = {
    revision: 0,
    orderedPreambleIds: [...input.orderedPreambleIds],
  };
  assertPreambleSelectionComposition(
    input.chatId,
    resolvePreambleSelection(selection, input.catalog, input.canonicalProjectPath).eligible,
  );
  return selection;
}

export { CHAT_ID_VALIDATION_SAMPLE };
