import { afterEach, describe, expect, it } from 'vitest';

import {
	ConversationExecutionDraftState,
	type ConversationExecutionSelection,
} from '../conversation-execution-draft-state.svelte.js';
import { chatExecutionDraftStorageKey } from '$lib/utils/local-persistence.js';

function selection(agentId = 'claude'): ConversationExecutionSelection {
	return {
		agentId,
		model: agentId === 'claude' ? 'sonnet' : 'gpt-5.5',
		apiProviderId: agentId === 'claude' ? null : 'openai',
		modelEndpointId: null,
		modelProtocol: agentId === 'claude' ? null : 'openai-compatible',
		permissionMode: 'default',
		thinkingMode: 'none',
		agentSettings: { ownerId: agentId, schemaVersion: 1, values: {} },
	};
}

describe('ConversationExecutionDraftState', () => {
	afterEach(() => localStorage.clear());

	it('persists a cross-agent target and restores it for the same chat', () => {
		let activeChatId: string | null = 'chat-1';
		let durableSelection = selection();
		const options = {
			get activeChatId() { return activeChatId; },
			get durableSelection() { return durableSelection; },
		};
		const draft = new ConversationExecutionDraftState(options);
		draft.activate('chat-1');
		draft.replaceSelection(selection('codex'));

		expect(draft.isHandoffPending).toBe(true);
		expect(draft.handoffRequest('epoch-1')).toEqual({
			target: selection('codex'),
			expectedAgentOwnershipEpoch: 'epoch-1',
		});

		const restored = new ConversationExecutionDraftState(options);
		expect(restored.activate('chat-1')).toEqual(selection('codex'));
		expect(restored.isHandoffPending).toBe(true);

		durableSelection = selection('codex');
		restored.acceptDurable(durableSelection);
		expect(restored.isHandoffPending).toBe(false);
		expect(localStorage.getItem(chatExecutionDraftStorageKey('chat-1'))).toBeNull();
		activeChatId = null;
	});

	it('drops malformed or same-owner persisted targets', () => {
		const durableSelection = selection();
		const options = {
			get activeChatId() { return 'chat-1'; },
			get durableSelection() { return durableSelection; },
		};
		localStorage.setItem(chatExecutionDraftStorageKey('chat-1'), '{broken');
		const malformed = new ConversationExecutionDraftState(options);
		expect(malformed.activate('chat-1')).toEqual(durableSelection);

		localStorage.setItem(
			chatExecutionDraftStorageKey('chat-1'),
			JSON.stringify(durableSelection),
		);
		const sameOwner = new ConversationExecutionDraftState(options);
		expect(sameOwner.activate('chat-1')).toEqual(durableSelection);
		expect(localStorage.getItem(chatExecutionDraftStorageKey('chat-1'))).toBeNull();
	});
});
