import { afterEach, describe, expect, it } from 'vitest';

import {
	ConversationExecutionDraftState,
	type ConversationExecutionSelection,
} from '../conversation-execution-draft-state.svelte.js';

function selection(agentId = 'claude'): ConversationExecutionSelection {
	return {
		agentId,
		executorId: 'local',
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

	it.each(['chat switch', 'deselection', 'reload'])('drops pending choices after %s', (leave) => {
		let activeChatId: string | null = 'chat-1';
		const durableSelection = { ...selection(), projectPath: '/saved' };
		const options = {
			get activeChatId() {
				return activeChatId;
			},
			get durableSelection() {
				return durableSelection;
			},
		};
		let draft = new ConversationExecutionDraftState(options);
		draft.activate('chat-1');
		const pending = { ...selection('codex'), executorId: 'remote', projectPath: '/chosen' };
		draft.replaceDestination(pending);

		expect(draft.isHandoffPending).toBe(true);
		expect(draft.handoffRequest('epoch-1')).toEqual({
			target: pending,
			expectedAgentOwnershipEpoch: 'epoch-1',
		});
		if (leave === 'reload') draft = new ConversationExecutionDraftState(options);
		else {
			activeChatId = leave === 'chat switch' ? 'chat-2' : null;
			draft.activate(activeChatId);
			expect(draft.isHandoffPending).toBe(false);
			activeChatId = 'chat-1';
		}
		expect(draft.activate('chat-1')).toEqual(durableSelection);
		expect(draft.handoffRequest('epoch-1')).toBeNull();
		expect(localStorage.length).toBe(0);
	});

	it('follows external ownership changes without treating the old owner as an explicit target', () => {
		let durableSelection = selection();
		const draft = new ConversationExecutionDraftState({
			get activeChatId() {
				return 'chat-1';
			},
			get durableSelection() {
				return durableSelection;
			},
		});
		draft.activate('chat-1');
		durableSelection = { ...selection('codex'), executorId: '22222222-2222-4222-8222-222222222222' };
		expect(draft.handoffRequest('epoch-2')).toBeNull();
		expect(draft.reconcileDurable()).toBeNull();
		expect(draft.selection).toEqual(durableSelection);
	});

	it('preserves an explicit target across external changes and clears it when that owner is installed', () => {
		let durableSelection = selection();
		const draft = new ConversationExecutionDraftState({
			get activeChatId() {
				return 'chat-1';
			},
			get durableSelection() {
				return durableSelection;
			},
		});
		draft.activate('chat-1');
		const staged = {
			...selection('codex'),
			executorId: '33333333-3333-4333-8333-333333333333',
			projectPath: '/explicit/destination',
		};
		draft.replaceSelection(staged);
		durableSelection = { ...selection(), executorId: '22222222-2222-4222-8222-222222222222' };
		expect(draft.reconcileDurable()).toBeNull();
		expect(draft.handoffRequest('epoch-2')).toEqual({
			target: staged,
			expectedAgentOwnershipEpoch: 'epoch-2',
		});
		durableSelection = { ...staged, projectPath: '/installed/destination' };
		expect(draft.reconcileDurable()).toEqual(durableSelection);
		expect(draft.handoffRequest('epoch-3')).toBeNull();
	});

	it.each(['same-executor', 'other-executor'])(
		'preserves a confirmed destination after a %s external move and settings edits',
		(move) => {
			let durableSelection = { ...selection(), projectPath: '/local' };
			const options = {
				get activeChatId() {
					return 'chat-1';
				},
				get durableSelection() {
					return durableSelection;
				},
			};
			const draft = new ConversationExecutionDraftState(options);
			draft.activate('chat-1');
			const staged = {
				...selection('codex'),
				executorId: '33333333-3333-4333-8333-333333333333',
				projectPath: '/explicit/destination',
			};
			draft.replaceSelection(staged);
			durableSelection = {
				...selection(),
				executorId: move === 'same-executor' ? staged.executorId : '22222222-2222-4222-8222-222222222222',
				projectPath: '/other',
			};
			draft.patchSelection({ model: 'another-model' });
			expect(draft.handoffRequest('epoch-2')).toEqual({
				target: { ...staged, model: 'another-model' },
				expectedAgentOwnershipEpoch: 'epoch-2',
			});
		},
	);

	it('updates a durable project path without rewriting the composer selection on unrelated snapshots', () => {
		let durableSelection = { ...selection(), projectPath: '/workspace/old' };
		const draft = new ConversationExecutionDraftState({
			get activeChatId() {
				return 'chat-1';
			},
			get durableSelection() {
				return durableSelection;
			},
		});
		draft.activate('chat-1');
		durableSelection = { ...durableSelection };
		expect(draft.reconcileDurable()).toBeNull();
		durableSelection = { ...durableSelection, projectPath: '/workspace/new' };
		expect(draft.reconcileDurable()).toEqual(durableSelection);
		expect(draft.isHandoffPending).toBe(false);
	});
});
