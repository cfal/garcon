import { normalizeChatBoardColumn } from '../../../../common/chat-boards.ts';

export function boardColumnRule(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || !('match' in value) || !('tags' in value)
      || !Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === 'string')) return false;
  return normalizeChatBoardColumn({
    id: '11111111-1111-4111-8111-111111111111', name: 'Fixture', match: value.match, tags: ['fixture'],
  }) !== null;
}
