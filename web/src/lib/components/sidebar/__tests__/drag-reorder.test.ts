import { describe, expect, it } from 'vitest';
import {
	moveInOrder,
	moveToBoundary,
	resolveFilteredRelativeMove,
	movedId,
} from '../drag-reorder';

describe('moveInOrder', () => {
	it('moves a source below a lower target on bottom edge', () => {
		expect(moveInOrder({
			order: ['a', 'b', 'c'],
			sourceChatId: 'a',
			targetChatId: 'c',
			closestEdge: 'bottom',
		})).toEqual(['b', 'c', 'a']);
	});

	it('moves a source above a lower target on top edge', () => {
		expect(moveInOrder({
			order: ['a', 'b', 'c'],
			sourceChatId: 'a',
			targetChatId: 'c',
			closestEdge: 'top',
		})).toEqual(['b', 'a', 'c']);
	});

	it('moves a source above a higher target on top edge', () => {
		expect(moveInOrder({
			order: ['a', 'b', 'c'],
			sourceChatId: 'c',
			targetChatId: 'a',
			closestEdge: 'top',
		})).toEqual(['c', 'a', 'b']);
	});

	it('returns null when the edge resolves to the current position', () => {
		expect(moveInOrder({
			order: ['a', 'b', 'c'],
			sourceChatId: 'c',
			targetChatId: 'b',
			closestEdge: 'bottom',
		})).toBeNull();
	});

	it('returns null when ids are missing', () => {
		expect(moveInOrder({
			order: ['a', 'b', 'c'],
			sourceChatId: 'missing',
			targetChatId: 'b',
			closestEdge: 'top',
		})).toBeNull();
	});
});

describe('moveToBoundary', () => {
	it('moves an item to the start', () => {
		expect(moveToBoundary({
			order: ['a', 'b', 'c'],
			chatId: 'c',
			boundary: 'start',
		})).toEqual(['c', 'a', 'b']);
	});

	it('moves an item to the end', () => {
		expect(moveToBoundary({
			order: ['a', 'b', 'c'],
			chatId: 'a',
			boundary: 'end',
		})).toEqual(['b', 'c', 'a']);
	});

	it('returns null when the item is already at the requested boundary', () => {
		expect(moveToBoundary({
			order: ['a', 'b', 'c'],
			chatId: 'a',
			boundary: 'start',
		})).toBeNull();
	});
});

describe('movedId', () => {
	it('returns the item that moved into the first differing slot', () => {
		expect(movedId(['a', 'b', 'c'], ['a', 'c', 'b'])).toBe('c');
	});

	it('returns null when orders have different members', () => {
		expect(movedId(['a', 'b'], ['a', 'c'])).toBeNull();
	});
});

describe('resolveFilteredRelativeMove', () => {
	it('uses the visible predecessor when one exists', () => {
		expect(resolveFilteredRelativeMove('c', ['a', 'c', 'b'])).toEqual({
			chatIdAbove: 'a',
		});
	});

	it('uses the visible successor for a top drop', () => {
		expect(resolveFilteredRelativeMove('c', ['c', 'a', 'b'])).toEqual({
			chatIdBelow: 'a',
		});
	});

	it('returns null when no visible neighbor exists', () => {
		expect(resolveFilteredRelativeMove('c', ['c'])).toBeNull();
	});

	it('returns null when the moved chat is not visible', () => {
		expect(resolveFilteredRelativeMove('missing', ['a', 'b'])).toBeNull();
	});
});
