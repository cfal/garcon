import { describe, expect, it } from 'bun:test';
import {
  calculateChatTagTransition,
  chatMatchesBoardColumn,
  normalizeChatBoardCatalog,
  normalizeChatBoardColumn,
} from '../chat-boards.ts';

const BOARD_ID = '11111111-1111-4111-8111-111111111111';
const COLUMN_A = '22222222-2222-4222-8222-222222222222';
const COLUMN_B = '33333333-3333-4333-8333-333333333333';

function board(overrides = {}) {
  return {
    id: BOARD_ID,
    name: 'Delivery',
    columns: [{ id: COLUMN_A, name: 'Ready', match: 'all', tags: ['ready', 'web'] }],
    ...overrides,
  };
}

describe('chat board contracts', () => {
  it('accepts canonical empty and populated catalogs', () => {
    expect(normalizeChatBoardCatalog({ revision: 0, boards: [] })).toEqual({
      revision: 0,
      boards: [],
    });
    expect(normalizeChatBoardCatalog({ revision: 4, boards: [board()] })).toEqual({
      revision: 4,
      boards: [board()],
    });
  });

  it('rejects unknown keys, noncanonical IDs, tags, and empty rules', () => {
    expect(normalizeChatBoardCatalog({ revision: 0, boards: [], extra: true })).toBeNull();
    expect(normalizeChatBoardCatalog({ revision: -1, boards: [] })).toBeNull();
    expect(normalizeChatBoardCatalog({ revision: 0, boards: [board({ id: 'board' })] })).toBeNull();
    expect(normalizeChatBoardColumn({
      id: COLUMN_A,
      name: 'Ready',
      match: 'all',
      tags: [],
    })).toBeNull();
    expect(normalizeChatBoardColumn({
      id: COLUMN_A,
      name: 'Ready',
      match: 'all',
      tags: ['Web'],
    })).toBeNull();
  });

  it('rejects duplicate identities and case-folded names across their scopes', () => {
    expect(normalizeChatBoardCatalog({
      revision: 0,
      boards: [board(), board({ name: 'delivery', columns: [], id: COLUMN_B })],
    })).toBeNull();
    expect(normalizeChatBoardCatalog({
      revision: 0,
      boards: [board({
        columns: [
          { id: COLUMN_A, name: 'Ready', match: 'all', tags: ['ready'] },
          { id: COLUMN_B, name: 'ready', match: 'any', tags: ['review'] },
        ],
      })],
    })).toBeNull();
  });

  it('implements exact ALL and ANY membership with an empty-rule defense', () => {
    expect(chatMatchesBoardColumn(['ready', 'web'], { match: 'all', tags: ['ready', 'web'] })).toBe(true);
    expect(chatMatchesBoardColumn(['ready'], { match: 'all', tags: ['ready', 'web'] })).toBe(false);
    expect(chatMatchesBoardColumn(['review'], { match: 'any', tags: ['ready', 'review'] })).toBe(true);
    expect(chatMatchesBoardColumn(['preview'], { match: 'any', tags: ['review'] })).toBe(false);
    expect(chatMatchesBoardColumn(['anything'], { match: 'all', tags: [] })).toBe(false);
  });

  it('calculates net transition changes and reapplies shared tags', () => {
    expect(calculateChatTagTransition({
      currentTags: ['customer-a', 'ready', 'shared'],
      sourceTags: ['ready', 'shared'],
      appliedTargetTags: ['review', 'shared'],
    })).toEqual({
      removedTags: ['ready'],
      addedTags: ['review'],
      resultingTags: ['customer-a', 'review', 'shared'],
    });
  });
});
