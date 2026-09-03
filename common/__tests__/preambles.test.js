import { describe, expect, it } from 'bun:test';
import {
  PREAMBLE_CONTENT_MAX_LENGTH,
  PREAMBLE_FILE_CONTEXT_SEPARATOR,
  PREAMBLE_MAX_COUNT,
  PREAMBLE_PATH_RULE_MAX_COUNT,
  PREAMBLE_TITLE_MAX_CODE_POINTS,
  normalizePendingPreambleBoundary,
  normalizePreambleDefinitionInput,
  normalizePreamblesMutationResponse,
  normalizePreamblesSnapshot,
} from '../preambles.js';
import {
  createPreamblePrefix,
  parsePreamblePrefixReceipt,
  preambleApplicationKey,
  renderPreamblePrefix,
} from '../preamble-prefix.js';

const CREATED_AT = '2026-09-03T10:00:00.000Z';

function definition(overrides = {}) {
  return {
    title: 'Repository conventions',
    content: 'Follow the repository conventions.',
    scope: { type: 'global' },
    ...overrides,
  };
}

function preamble(id, overrides = {}) {
  return {
    id,
    ...definition(),
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

describe('preamble contracts', () => {
  it('normalizes global and independently nested project-path scopes', () => {
    expect(normalizePreambleDefinitionInput(definition())).toEqual(definition());
    expect(normalizePreambleDefinitionInput(definition({
      scope: {
        type: 'project-paths',
        rules: [
          { projectPath: ' /workspace/one ', includeNested: true },
          { projectPath: '/workspace/two', includeNested: false },
        ],
      },
    }))).toEqual(definition({
      scope: {
        type: 'project-paths',
        rules: [
          { projectPath: '/workspace/one', includeNested: true },
          { projectPath: '/workspace/two', includeNested: false },
        ],
      },
    }));
  });

  it('preserves body whitespace while trimming a bounded single-line title', () => {
    expect(normalizePreambleDefinitionInput(definition({
      title: '  Conventions  ',
      content: '  Keep these boundaries.\n',
    }))).toEqual(definition({
      title: 'Conventions',
      content: '  Keep these boundaries.\n',
    }));
    expect(normalizePreambleDefinitionInput(definition({ title: 'a'.repeat(PREAMBLE_TITLE_MAX_CODE_POINTS) }))).not.toBeNull();
    expect(normalizePreambleDefinitionInput(definition({ title: 'a'.repeat(PREAMBLE_TITLE_MAX_CODE_POINTS + 1) }))).toBeNull();
    expect(normalizePreambleDefinitionInput(definition({ title: 'two\nlines' }))).toBeNull();
  });

  it('rejects blank, oversized, file-context-colliding, and unknown fields', () => {
    expect(normalizePreambleDefinitionInput(definition({ content: '  ' }))).toBeNull();
    expect(normalizePreambleDefinitionInput(definition({ content: 'x'.repeat(PREAMBLE_CONTENT_MAX_LENGTH + 1) }))).toBeNull();
    expect(normalizePreambleDefinitionInput(definition({ content: `before${PREAMBLE_FILE_CONTEXT_SEPARATOR}after` }))).toBeNull();
    expect(normalizePreambleDefinitionInput({ ...definition(), unexpected: true })).toBeNull();
    expect(normalizePreambleDefinitionInput(definition({ scope: { type: 'global', rules: [] } }))).toBeNull();
  });

  it('requires one through the bounded number of unique path rules', () => {
    expect(normalizePreambleDefinitionInput(definition({
      scope: { type: 'project-paths', rules: [] },
    }))).toBeNull();
    expect(normalizePreambleDefinitionInput(definition({
      scope: {
        type: 'project-paths',
        rules: Array.from({ length: PREAMBLE_PATH_RULE_MAX_COUNT + 1 }, (_, index) => ({
          projectPath: `/workspace/${index}`,
          includeNested: false,
        })),
      },
    }))).toBeNull();
    expect(normalizePreambleDefinitionInput(definition({
      scope: {
        type: 'project-paths',
        rules: [
          { projectPath: '/workspace/one', includeNested: false },
          { projectPath: ' /workspace/one ', includeNested: true },
        ],
      },
    }))).toBeNull();
  });

  it('normalizes snapshots defensively and rejects duplicate IDs or excess entries', () => {
    const snapshot = normalizePreamblesSnapshot({ revision: 2, preambles: [preamble('a')] });
    expect(snapshot).toEqual({ revision: 2, preambles: [preamble('a')] });
    expect(normalizePreamblesSnapshot({ revision: 2, preambles: [preamble('a'), preamble('a')] })).toBeNull();
    expect(normalizePreamblesSnapshot({
      revision: 2,
      preambles: Array.from({ length: PREAMBLE_MAX_COUNT + 1 }, (_, index) => preamble(String(index))),
    })).toBeNull();
    expect(normalizePreamblesSnapshot({ revision: 2, preambles: [], extra: true })).toBeNull();
  });

  it('parses only complete mutation responses and pending boundaries', () => {
    expect(normalizePreamblesMutationResponse({
      success: true,
      snapshot: { revision: 0, preambles: [] },
    })).toEqual({ success: true, snapshot: { revision: 0, preambles: [] } });
    expect(normalizePreamblesMutationResponse({
      success: true,
      snapshot: { revision: 0, preambles: [] },
      extra: true,
    })).toBeNull();
    expect(normalizePendingPreambleBoundary({
      kind: 'fork',
      ownershipEpoch: 'epoch-one',
    })).toEqual({ kind: 'fork', ownershipEpoch: 'epoch-one' });
    expect(normalizePendingPreambleBoundary({ kind: 'turn', ownershipEpoch: 'epoch-one' })).toBeNull();
  });
});

describe('preamble prefix contract', () => {
  it('freezes the application key and exact version-one envelope', () => {
    const key = preambleApplicationKey('view-one', 'message-one');
    expect(key).toBe('be8415a5759829f6b0de113e39770b992bb7176b59f5e6e32a65f65dda11bd1b');
    expect(renderPreamblePrefix(key, ['first\nbody', 'second body'])).toBe(
      `<garcon-preambles version="1" application="${key}">\nfirst\nbody\n\nsecond body\n</garcon-preambles>\n\n`,
    );
  });

  it('creates and validates a body-free exact sanitation receipt', () => {
    const application = createPreamblePrefix({
      viewId: 'view-one',
      clientMessageId: 'message-one',
      contents: ['private body'],
    });
    expect(application).not.toBeNull();
    expect(application.receipt.codeUnitLength).toBe(application.prefix.length);
    expect(application.receipt).not.toHaveProperty('content');
    expect(parsePreamblePrefixReceipt(application.receipt)).toEqual(application.receipt);
    expect(parsePreamblePrefixReceipt({ ...application.receipt, extra: true })).toBeNull();
    expect(createPreamblePrefix({
      viewId: 'view-one',
      clientMessageId: 'message-one',
      contents: [],
    })).toBeNull();
  });
});
