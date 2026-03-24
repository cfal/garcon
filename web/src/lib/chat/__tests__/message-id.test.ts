import { describe, it, expect } from 'vitest';
import {
	ToolResultMessage,
	PermissionRequestMessage,
	UserMessage,
	AssistantMessage,
	ThinkingMessage,
	ErrorMessage,
	BashToolUseMessage,
	ReadToolUseMessage,
} from '$shared/chat-types';
import { deriveMessageId, createMessageIdAllocator } from '../message-id';

const NOW = '2026-02-28T12:00:00.000Z';

describe('deriveMessageId', () => {
	it('produces deterministic IDs for same content', () => {
		const msg1 = new UserMessage(NOW, 'Hello world');
		const msg2 = new UserMessage(NOW, 'Hello world');
		expect(deriveMessageId(msg1)).toBe(deriveMessageId(msg2));
	});

	it('produces IDs starting with msg_ prefix', () => {
		const msg = new UserMessage(NOW, 'hello');
		expect(deriveMessageId(msg)).toMatch(/^msg_[0-9a-f]{8}$/);
	});

	it('produces different IDs for different message types', () => {
		const user = new UserMessage(NOW, 'content');
		const assistant = new AssistantMessage(NOW, 'content');
		expect(deriveMessageId(user)).not.toBe(deriveMessageId(assistant));
	});

	it('produces different IDs for different content', () => {
		const msg1 = new UserMessage(NOW, 'hello');
		const msg2 = new UserMessage(NOW, 'goodbye');
		expect(deriveMessageId(msg1)).not.toBe(deriveMessageId(msg2));
	});

	it('handles tool-use messages via toolId', () => {
		const msg = new BashToolUseMessage(NOW, 'tool-abc', 'ls');
		const id = deriveMessageId(msg);
		expect(id).toMatch(/^msg_/);
	});

	it('handles tool-result messages', () => {
		const msg = new ToolResultMessage(NOW, 'tool-xyz', { raw: 'ok' }, false);
		const id = deriveMessageId(msg);
		expect(id).toMatch(/^msg_/);
	});

	it('handles permission-request messages', () => {
		const msg = new PermissionRequestMessage(NOW, 'perm-123', new BashToolUseMessage(NOW, 'tool-1', 'rm -rf /'));
		const id = deriveMessageId(msg);
		expect(id).toMatch(/^msg_/);
	});

	it('handles invalid timestamp gracefully', () => {
		const msg = new UserMessage('not-a-date', 'hi');
		const id = deriveMessageId(msg);
		expect(id).toMatch(/^msg_/);
	});

	it('differentiates tool-use from tool-result with same toolId', () => {
		const toolUse = new BashToolUseMessage(NOW, 'tool-1', 'echo hi');
		const toolResult = new ToolResultMessage(NOW, 'tool-1', { raw: 'hi' }, false);
		expect(deriveMessageId(toolUse)).not.toBe(deriveMessageId(toolResult));
	});
});

describe('createMessageIdAllocator', () => {
	it('memoizes by object reference (WeakMap)', () => {
		const allocator = createMessageIdAllocator();
		const msg = new AssistantMessage(NOW, 'response');
		const id1 = allocator(msg);
		const id2 = allocator(msg);
		expect(id1).toBe(id2);
	});

	it('assigns collision-suffixed IDs for identical fingerprints', () => {
		const allocator = createMessageIdAllocator();
		const msg1 = new ThinkingMessage(NOW, 'thinking...');
		const msg2 = new ThinkingMessage(NOW, 'thinking...');
		const id1 = allocator(msg1);
		const id2 = allocator(msg2);
		expect(id1).not.toBe(id2);
		expect(id2).toContain('_');
	});

	it('gives different objects with same content unique IDs', () => {
		const allocator = createMessageIdAllocator();
		const msg1 = new ErrorMessage(NOW, 'fail');
		const msg2 = new ErrorMessage(NOW, 'fail');
		const id1 = allocator(msg1);
		const id2 = allocator(msg2);
		expect(id1).not.toBe(id2);
	});

	it('returns same ID when same object is called twice', () => {
		const allocator = createMessageIdAllocator();
		const msg = new ReadToolUseMessage(NOW, 'tool-1', '/a.ts');
		expect(allocator(msg)).toBe(allocator(msg));
	});

	it('all IDs start with msg_ prefix', () => {
		const allocator = createMessageIdAllocator();
		const msg1 = new UserMessage(NOW, 'hello');
		const msg2 = new UserMessage(NOW, 'hello');
		expect(allocator(msg1)).toMatch(/^msg_/);
		expect(allocator(msg2)).toMatch(/^msg_/);
	});

	it('handles three-way collision with incremented suffixes', () => {
		const allocator = createMessageIdAllocator();
		const msg1 = new UserMessage(NOW, 'same');
		const msg2 = new UserMessage(NOW, 'same');
		const msg3 = new UserMessage(NOW, 'same');
		const id1 = allocator(msg1);
		const id2 = allocator(msg2);
		const id3 = allocator(msg3);
		expect(new Set([id1, id2, id3]).size).toBe(3);
		expect(id1).not.toContain('_1');
		expect(id2).toContain('_1');
		expect(id3).toContain('_2');
	});

	it('reset() clears collision state for bounded memory', () => {
		const allocator = createMessageIdAllocator();
		const msg1 = new UserMessage(NOW, 'dup');
		const msg2 = new UserMessage(NOW, 'dup');
		allocator(msg1);
		const before = allocator(msg2);
		expect(before).toContain('_1');

		allocator.reset();

		// After reset, a new object with same fingerprint gets the base
		// ID again (no collision suffix carry-over).
		const msg3 = new UserMessage(NOW, 'dup');
		const after = allocator(msg3);
		const baseId = deriveMessageId(msg3);
		expect(after).toBe(baseId);
	});

	it('reset() does not invalidate WeakMap memoization for live objects', () => {
		const allocator = createMessageIdAllocator();
		const msg = new UserMessage(NOW, 'persist');
		const idBefore = allocator(msg);

		allocator.reset();

		// Same object reference still returns the memoized ID.
		const idAfter = allocator(msg);
		expect(idAfter).toBe(idBefore);
	});
});
