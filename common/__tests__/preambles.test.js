import { describe, expect, it } from 'bun:test';
import {
  PREAMBLE_CHAT_ID_TOKEN,
  PREAMBLE_CONTENT_MAX_LENGTH,
  PREAMBLE_FILE_CONTEXT_SEPARATOR,
  PREAMBLE_MAX_COUNT,
  PREAMBLE_PATH_RULE_MAX_COUNT,
  PREAMBLE_TITLE_MAX_CODE_POINTS,
  normalizePendingPreambleBoundary,
  normalizePreambleDefinitionInput,
  normalizePreamblesMutationResponse,
  normalizePreamblesSnapshot,
  renderPreambleContent,
} from '../preambles.js';
import {
  createPreamblePrefix,
  parsePreamblePrefixReceipt,
  preamblePrefixSha256,
  renderPreamblePrefix,
} from '../preamble-prefix.js';

const CREATED_AT = '2026-09-03T10:00:00.000Z';

function definition(overrides = {}) {
  return {
    enabled: true,
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

    expect(normalizePreambleDefinitionInput({ ...definition(), enabled: undefined })).toBeNull();
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
  it('renders active chat ID tokens and unescapes escaped tokens', () => {
    const chatId = '1783725900000000';
    expect(renderPreambleContent(
      `Chat ${PREAMBLE_CHAT_ID_TOKEN}; literal \\${PREAMBLE_CHAT_ID_TOKEN}; unknown {{project_path}}`,
      chatId,
    )).toBe(`Chat ${chatId}; literal ${PREAMBLE_CHAT_ID_TOKEN}; unknown {{project_path}}`);
  });

  it('freezes the exact version-one envelope without an application identifier', () => {
    expect(renderPreamblePrefix(['first\nbody', 'second body'])).toBe(
      '<garcon-preambles version="1">\nfirst\nbody\n\nsecond body\n</garcon-preambles>\n\n<!-- garcon-preamble-input --> ',
    );
  });

  it('creates and validates a body-free exact sanitation receipt', () => {
    const application = createPreamblePrefix({
      contents: ['private body'],
    });
    expect(application).not.toBeNull();
    expect(application.receipt.codeUnitLength).toBe(application.prefix.length);
    expect(application.receipt).not.toHaveProperty('content');
    expect(application.receipt).not.toHaveProperty('applicationKey');
    expect(parsePreamblePrefixReceipt(application.receipt)).toEqual(application.receipt);
    expect(parsePreamblePrefixReceipt({ ...application.receipt, extra: true })).toBeNull();
    expect(parsePreamblePrefixReceipt({
      ...application.receipt,
      applicationKey: '0'.repeat(64),
    })).toBeNull();
    expect(createPreamblePrefix({
      contents: [],
    })).toBeNull();
  });

  it('hashes exact UTF-16 code units without surrogate replacement collisions', () => {
    const unpairedSurrogate = createPreamblePrefix({ contents: ['\ud800'] });
    const replacementCharacter = createPreamblePrefix({ contents: ['\ufffd'] });

    expect(preamblePrefixSha256('A\ud800\ufffd')).toBe(
      'c5c20e249fb6e2f199df43e7379e58eb6ebff17d73f21d96cf61aa2fba6afaca',
    );
    expect(unpairedSurrogate.prefix.length).toBe(replacementCharacter.prefix.length);
    expect(unpairedSurrogate.receipt.sha256).not.toBe(replacementCharacter.receipt.sha256);
  });
});
