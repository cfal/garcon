// Deterministic message ID generation for chat message lists. Produces
// stable IDs for Svelte {#each} keyed blocks so that DOM nodes survive
// array mutations like prepends and appends. Uses FNV-1a hashing over
// a type-aware fingerprint for collision resistance.

import {
	ToolUseMessage,
	ToolResultMessage,
	PermissionRequestMessage,
	PermissionResolvedMessage,
	PermissionCancelledMessage,
	UserMessage,
	AssistantMessage,
	ThinkingMessage,
	ErrorMessage,
} from '$shared/chat-types';
import type { ChatMessage } from '$shared/chat-types';

function normalizeString(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function fingerprintBase(message: ChatMessage): string {
	const ts = Number.isFinite(new Date(message.timestamp).getTime())
		? String(new Date(message.timestamp).getTime())
		: 'no-ts';

	if (message instanceof ToolUseMessage) {
		return `tool-use|${message.rawName}|${message.toolId}|${ts}`;
	}
	if (message instanceof ToolResultMessage) {
		const content = JSON.stringify(message.content ?? {});
		return `tool-result|${message.toolId}|${message.isError ? 'err' : 'ok'}|${content}|${ts}`;
	}
	if (message instanceof PermissionRequestMessage) {
		return `perm-req|${message.permissionRequestId}|${message.toolName}|${ts}`;
	}
	if (message instanceof PermissionResolvedMessage) {
		return `perm-res|${message.permissionRequestId}|${message.allowed ? '1' : '0'}|${ts}`;
	}
	if (message instanceof PermissionCancelledMessage) {
		return `perm-cancel|${message.permissionRequestId}|${message.reason ?? ''}|${ts}`;
	}
	if (
		message instanceof UserMessage ||
		message instanceof AssistantMessage ||
		message instanceof ThinkingMessage ||
		message instanceof ErrorMessage
	) {
		const content = normalizeString(message.content).slice(0, 256);
		return `${message.type}|${content}|${ts}`;
	}
	return `${(message as { type: string }).type}|${ts}`;
}

function fnv1a32(input: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i += 1) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Derives a deterministic message ID from the message's type-specific fields. */
export function deriveMessageId(message: ChatMessage): string {
	const base = fingerprintBase(message);
	return `msg_${fnv1a32(base)}`;
}

export type MessageIdAllocator = ((message: ChatMessage) => string) & {
	/** Clears collision state. Call on chat switch to bound memory growth. */
	reset: () => void;
};

/**
 * Creates a stateful allocator that guarantees unique, stable message IDs
 * across message list mutations. Uses a WeakMap for object-reference
 * memoization and collision-suffixed IDs when fingerprints collide.
 *
 * Call `allocator.reset()` when the chat changes to prevent unbounded
 * growth of the collision tracking structures.
 */
export function createMessageIdAllocator(): MessageIdAllocator {
	const byRef = new WeakMap<ChatMessage, string>();
	let allocated = new Set<string>();
	let collisionCounter = new Map<string, number>();

	const getId = ((message: ChatMessage): string => {
		const existing = byRef.get(message);
		if (existing) return existing;

		const base = deriveMessageId(message);
		let candidate = base;

		if (allocated.has(candidate)) {
			const next = (collisionCounter.get(base) ?? 0) + 1;
			collisionCounter.set(base, next);
			candidate = `${base}_${next}`;
		}

		allocated.add(candidate);
		byRef.set(message, candidate);
		return candidate;
	}) as MessageIdAllocator;

	getId.reset = () => {
		allocated = new Set();
		collisionCounter = new Map();
	};

	return getId;
}
