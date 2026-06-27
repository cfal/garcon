import { describe, expect, it } from 'vitest';
import {
	CHAT_FEED_CONTENT_BASE_CLASS,
	CHAT_MAX_WIDTH_COMPOSER_SHELL_CLASS,
	CHAT_MAX_WIDTH_FEED_CONTENT_CLASS,
} from '../chat-max-width';

describe('chat max width classes', () => {
	it('keeps the mobile transcript inset inside the composer corner area', () => {
		expect(CHAT_FEED_CONTENT_BASE_CLASS).toContain('px-[29px]');
	});

	it('keeps the none-width desktop transcript inset inside the composer corner area', () => {
		expect(CHAT_MAX_WIDTH_FEED_CONTENT_CLASS.none).toContain('lg:px-8');
		expect(CHAT_MAX_WIDTH_COMPOSER_SHELL_CLASS.none).toContain('lg:px-3');
	});
});
