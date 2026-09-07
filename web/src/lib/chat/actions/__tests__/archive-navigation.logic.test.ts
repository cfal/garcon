import { describe, expect, it } from 'vitest';
import { resolveArchiveReplacementChatId } from '../archive-navigation';

describe('resolveArchiveReplacementChatId', () => {
	it('selects the next displayed chat before the previous one', () => {
		expect(
			resolveArchiveReplacementChatId({
				archivingChatId: 'selected',
				displayedChatIds: ['previous', 'selected', 'next'],
				isSelectableChat: () => true,
			}),
		).toBe('next');
	});

	it('falls back to the previous eligible displayed chat', () => {
		expect(
			resolveArchiveReplacementChatId({
				archivingChatId: 'selected',
				displayedChatIds: ['previous', 'selected', 'excluded'],
				isSelectableChat: (chatId) => chatId !== 'excluded',
			}),
		).toBe('previous');
	});

	it('returns null when the archived chat is absent or has no eligible neighbor', () => {
		const input = {
			archivingChatId: 'selected',
			displayedChatIds: ['selected'],
			isSelectableChat: () => true,
		};

		expect(resolveArchiveReplacementChatId(input)).toBeNull();
		expect(
			resolveArchiveReplacementChatId({ ...input, displayedChatIds: ['another-chat'] }),
		).toBeNull();
	});
});
