import { describe, expect, it } from 'vitest';
import { ConversationFeedItemState, disclosureStateKey } from '../ConversationFeedItemState.svelte';

const PERMISSION_OCCURRENCE = 'incarnation-1';

describe('ConversationFeedItemState', () => {
	it('stores only disclosure values that differ from the current default', () => {
		const items = new ConversationFeedItemState();
		items.reconcile('chat-1:generation-1', new Set(['row-1']), new Set());
		const disclosure = items.disclosurePort('row-1');

		expect(items.hasDisclosureOverrides).toBe(false);
		expect(disclosure.open('thinking', 'thinking', true)).toBe(true);
		disclosure.setOpen('thinking', 'thinking', false, true);
		expect(items.hasDisclosureOverrides).toBe(true);
		expect(disclosure.open('thinking', 'thinking', true)).toBe(false);
		disclosure.setOpen('thinking', 'thinking', true, true);
		expect(items.hasDisclosureOverrides).toBe(false);
		expect(disclosure.open('thinking', 'thinking', false)).toBe(false);
	});

	it('keeps tool and message-body disclosures independent', () => {
		const items = new ConversationFeedItemState();
		items.reconcile('chat-1:generation-1', new Set(['row-1']), new Set());
		const disclosure = items.disclosurePort('row-1');
		disclosure.setOpen('tool-input', 'tool-1', true, false);
		disclosure.setOpen('cli-body', 'body', true, false);

		expect(disclosure.open('tool-input', 'tool-1', false)).toBe(true);
		expect(disclosure.open('tool-result', 'tool-1', false)).toBe(false);
		expect(disclosure.open('user-body', 'body', false)).toBe(false);
		expect(disclosure.open('cli-body', 'body', false)).toBe(true);
	});

	it('preserves permission drafts across ordinary row remounts', () => {
		const items = new ConversationFeedItemState();
		items.reconcile('chat-1:generation-1', new Set(['row-1']), new Set([PERMISSION_OCCURRENCE]));
		items.setPermissionDraft(PERMISSION_OCCURRENCE, {
			selectedQuestionOptions: { question: ['answer'] },
			questionTextAnswers: { question: '  Saved note\n ', details: 'Custom answer' },
			rawInputOpen: true,
		});
		items.reconcile('chat-1:generation-1', new Set(), new Set([PERMISSION_OCCURRENCE]));
		items.reconcile('chat-1:generation-1', new Set(['row-1']), new Set([PERMISSION_OCCURRENCE]));

		expect(items.permissionDraft(PERMISSION_OCCURRENCE)).toEqual({
			selectedQuestionOptions: { question: ['answer'] },
			questionTextAnswers: { question: '  Saved note\n ', details: 'Custom answer' },
			rawInputOpen: true,
		});
	});

	it('keeps drafts independent across permission occurrences', () => {
		const items = new ConversationFeedItemState();
		const first = 'incarnation-1';
		const second = 'incarnation-2';
		items.reconcile('chat-1:generation-1', new Set(), new Set([first, second]));
		items.setPermissionDraft(first, {
			selectedQuestionOptions: { database: ['Postgres'] },
			questionTextAnswers: { database: 'First note' },
			rawInputOpen: false,
		});
		items.setPermissionDraft(second, {
			selectedQuestionOptions: { database: ['SQLite'] },
			questionTextAnswers: { database: 'Second note' },
			rawInputOpen: true,
		});

		expect(items.permissionDraft(first)).toEqual({
			selectedQuestionOptions: { database: ['Postgres'] },
			questionTextAnswers: { database: 'First note' },
			rawInputOpen: false,
		});
		expect(items.permissionDraft(second)).toEqual({
			selectedQuestionOptions: { database: ['SQLite'] },
			questionTextAnswers: { database: 'Second note' },
			rawInputOpen: true,
		});

		items.reconcile('chat-1:generation-1', new Set(), new Set([second]));

		expect(items.permissionDraft(first).selectedQuestionOptions).toEqual({});
		expect(items.permissionDraft(first).questionTextAnswers).toBeUndefined();
		expect(items.permissionDraft(second).questionTextAnswers).toEqual({ database: 'Second note' });
		expect(items.permissionDraft(second).selectedQuestionOptions).toEqual({
			database: ['SQLite'],
		});
	});

	it('prunes rows and resolved permissions from the active data window', () => {
		const items = new ConversationFeedItemState();
		items.reconcile('chat-1:generation-1', new Set(['row-1']), new Set([PERMISSION_OCCURRENCE]));
		items.setDisclosureOpen(disclosureStateKey('row-1', 'compaction', 'summary'), true, false);
		expect(items.hasDisclosureOverrides).toBe(true);
		items.setPermissionDraft(PERMISSION_OCCURRENCE, {
			selectedQuestionOptions: { question: ['answer'] },
			rawInputOpen: true,
		});
		items.reconcile('chat-1:generation-1', new Set(), new Set());
		expect(items.hasDisclosureOverrides).toBe(false);

		expect(items.disclosureOpen(disclosureStateKey('row-1', 'compaction', 'summary'), false)).toBe(
			false,
		);
		expect(items.permissionDraft(PERMISSION_OCCURRENCE)).toEqual({
			selectedQuestionOptions: {},
			rawInputOpen: false,
		});
	});

	it.each(['chat-2:generation-1', 'chat-1:generation-2'])('clears presentation state on surface replacement: %s', (surface) => {
		const items = new ConversationFeedItemState();
		items.reconcile('chat-1:generation-1', new Set(['row-1']), new Set([PERMISSION_OCCURRENCE]));
		items.disclosurePort('row-1').setOpen('thinking', 'thinking', false, true);
		items.setPermissionDraft(PERMISSION_OCCURRENCE, {
			selectedQuestionOptions: { question: ['answer'] },
			questionTextAnswers: { question: 'Saved note' },
			rawInputOpen: true,
		});
		items.reconcile(surface, new Set(['row-1']), new Set([PERMISSION_OCCURRENCE]));

		expect(items.disclosurePort('row-1').open('thinking', 'thinking', true)).toBe(true);
		expect(items.permissionDraft(PERMISSION_OCCURRENCE).selectedQuestionOptions).toEqual({});
		expect(items.permissionDraft(PERMISSION_OCCURRENCE).questionTextAnswers).toBeUndefined();
	});
});
