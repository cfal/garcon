import { describe, expect, it } from 'vitest';
import {
	CHAT_WINDOW_TEXT_SCALE_DEFAULT,
	CHAT_WINDOW_TEXT_SCALE_FOUR_WINDOWS,
	CHAT_WINDOW_TEXT_SCALE_TWO_WINDOWS,
	getChatWindowTextScale,
} from '../chat-window-text-scale.js';

describe('getChatWindowTextScale', () => {
	it('keeps normal scale outside multi-window layouts', () => {
		expect(getChatWindowTextScale(0)).toBe(CHAT_WINDOW_TEXT_SCALE_DEFAULT);
		expect(getChatWindowTextScale(1)).toBe(CHAT_WINDOW_TEXT_SCALE_DEFAULT);
	});

	it('uses the compact scale for two and three windows', () => {
		expect(getChatWindowTextScale(2)).toBe(CHAT_WINDOW_TEXT_SCALE_TWO_WINDOWS);
		expect(getChatWindowTextScale(3)).toBe(CHAT_WINDOW_TEXT_SCALE_TWO_WINDOWS);
	});

	it('uses the dense scale for four or more windows', () => {
		expect(getChatWindowTextScale(4)).toBe(CHAT_WINDOW_TEXT_SCALE_FOUR_WINDOWS);
		expect(getChatWindowTextScale(5)).toBe(CHAT_WINDOW_TEXT_SCALE_FOUR_WINDOWS);
	});
});
