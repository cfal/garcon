import { describe, expect, it } from 'bun:test';
import { DomainError } from '../../lib/domain-error.ts';
import {
  assertPreambleSelectionComposition,
  defaultOrderedPreambleIds,
  isRecoverablePreambleAdmissionError,
  PREAMBLE_SELECTION_COMPOSITION_INVALID_MESSAGE,
  projectPreambleSelection,
  resolveNewChatPreambleSelection,
  resolvePreambleSelection,
} from '../selection.ts';

const AT = '2026-09-03T10:00:00.000Z';
const ID_A = '3502b645-222b-49d2-ac39-1c91f9fb1174';
const ID_B = '80becfa6-c9c7-4b31-9190-fd23c0bedf9c';
const ID_MISSING = '936903ad-8b98-43eb-a7d4-c17ce0dc18d8';

function preamble(id, title, content, overrides = {}) {
  return {
    id,
    enabled: true,
    title,
    content,
    scope: { type: 'global' },
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function catalog(...preambles) {
  return { revision: preambles.length + 1, preambles };
}

function selection(ids, revision = 1) {
  return { revision, orderedPreambleIds: ids };
}

describe('resolvePreambleSelection', () => {
  it('iterates saved order rather than catalog order', () => {
    const resolved = resolvePreambleSelection(
      selection([ID_B, ID_A]),
      catalog(
        preamble(ID_A, 'First', 'first body'),
        preamble(ID_B, 'Second', 'second body'),
      ),
      '/repo',
    );
    expect(resolved.eligible.map((entry) => entry.title)).toEqual(['Second', 'First']);
    expect(resolved.unavailable).toEqual([]);
  });

  it('classifies missing, disabled, and out-of-scope IDs without failing', () => {
    const resolved = resolvePreambleSelection(
      selection([ID_MISSING, ID_A, ID_B]),
      catalog(
        preamble(ID_A, 'Eligible', 'eligible body'),
        preamble(ID_B, 'Disabled', 'disabled body', { enabled: false }),
      ),
      '/repo',
    );
    expect(resolved.eligible.map((entry) => entry.id)).toEqual([ID_A]);
    expect(resolved.unavailable).toEqual([
      { id: ID_MISSING, reason: 'missing' },
      { id: ID_B, reason: 'disabled' },
    ]);
  });

  it('reports out-of-scope entries for non-matching project paths', () => {
    const resolved = resolvePreambleSelection(
      selection([ID_A]),
      catalog(preamble(ID_A, 'Scoped', 'scoped body', {
        scope: { type: 'project-paths', rules: [{ projectPath: '/other', includeNested: true }] },
      })),
      '/repo',
    );
    expect(resolved.unavailable).toEqual([{ id: ID_A, reason: 'out-of-scope' }]);
  });

  it('projects eligible titles and unavailable reasons for the UI', () => {
    const projection = projectPreambleSelection(
      selection([ID_A, ID_MISSING]),
      catalog(preamble(ID_A, 'Eligible', 'eligible body')),
      '/repo',
    );
    expect(projection).toEqual({
      catalogRevision: 2,
      eligiblePreambles: [{ id: ID_A, title: 'Eligible' }],
      unavailable: [{ id: ID_MISSING, reason: 'missing' }],
    });
  });

  it('defaults new chats to enabled matching entries in catalog order', () => {
    const ids = defaultOrderedPreambleIds(
      catalog(
        preamble(ID_A, 'First', 'first'),
        preamble(ID_B, 'Disabled', 'second', { enabled: false }),
        preamble(ID_MISSING, 'Scoped', 'third', {
          scope: { type: 'project-paths', rules: [{ projectPath: '/repo', includeNested: true }] },
        }),
      ),
      '/repo',
    );
    expect(ids).toEqual([ID_A, ID_MISSING]);
  });

  it('resolves an omitted creation selection to defaults and stores explicit lists exactly', () => {
    const snapshot = catalog(preamble(ID_A, 'First', 'first'));
    expect(resolveNewChatPreambleSelection({
      catalog: snapshot,
      canonicalProjectPath: '/repo',
      chatId: '1783725900000200',
    })).toEqual({ revision: 0, orderedPreambleIds: [ID_A] });
    expect(resolveNewChatPreambleSelection({
      catalog: snapshot,
      canonicalProjectPath: '/repo',
      chatId: '1783725900000200',
      orderedPreambleIds: [ID_MISSING],
    })).toEqual({ revision: 0, orderedPreambleIds: [ID_MISSING] });
    expect(resolveNewChatPreambleSelection({
      catalog: snapshot,
      canonicalProjectPath: '/repo',
      chatId: '1783725900000200',
      orderedPreambleIds: [],
    })).toEqual({ revision: 0, orderedPreambleIds: [] });
  });

  it('rejects an unsafe explicit creation composition before persistence', () => {
    expect(() => resolveNewChatPreambleSelection({
      catalog: catalog(
        preamble(ID_A, 'Tail', '\nReferenced file contents from @file mentions:'),
        preamble(ID_B, 'Head', 'Synthetic content\n\n'),
      ),
      canonicalProjectPath: '/repo',
      chatId: '1783725900000200',
      orderedPreambleIds: [ID_A, ID_B],
    })).toThrowError(expect.objectContaining({
      code: 'PREAMBLE_SELECTION_COMPOSITION_INVALID',
      message: PREAMBLE_SELECTION_COMPOSITION_INVALID_MESSAGE,
    }));
  });
});

describe('assertPreambleSelectionComposition', () => {
  it('accepts empty and safe compositions and expands chat IDs exactly', () => {
    expect(() => assertPreambleSelectionComposition('1783725900000200', [])).not.toThrow();
    expect(() => assertPreambleSelectionComposition('1783725900000200', [
      preamble(ID_A, 'One', 'Target {{chat_id}}'),
    ])).not.toThrow();
  });

  it('rejects a reordered pair that reconstructs the reserved separator', () => {
    const entries = [
      { id: ID_A, body: 'Synthetic content\n\n' },
      { id: ID_B, body: '\nReferenced file contents from @file mentions:' },
    ];
    // The frame's opening newline plus the leading body newline reconstructs the
    // reserved separator only in this order; the reverse order stays safe.
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const ordered = [byId.get(ID_B), byId.get(ID_A)];
    expect(() => assertPreambleSelectionComposition('1783725900000200', ordered.map(
      (entry, index) => preamble(entry.id, `Entry ${index}`, entry.body),
    ))).toThrowError(expect.objectContaining({ code: 'PREAMBLE_SELECTION_COMPOSITION_INVALID' }));
  });

  it('treats composition and slash rejections as the recoverable admission errors', () => {
    expect(isRecoverablePreambleAdmissionError(new DomainError(
      'PREAMBLE_SELECTION_COMPOSITION_INVALID',
      PREAMBLE_SELECTION_COMPOSITION_INVALID_MESSAGE,
      422,
    ))).toBe(true);
    expect(isRecoverablePreambleAdmissionError(new DomainError(
      'PREAMBLE_SLASH_COMMAND_BLOCKED',
      'blocked',
      422,
    ))).toBe(true);
    expect(isRecoverablePreambleAdmissionError(new DomainError(
      'SESSION_NOT_FOUND',
      'missing',
      404,
    ))).toBe(false);
    expect(isRecoverablePreambleAdmissionError(new Error('not domain'))).toBe(false);
  });
});
