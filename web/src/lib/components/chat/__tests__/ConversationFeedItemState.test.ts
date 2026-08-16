import { describe, expect, it } from 'vitest';
import { ConversationFeedItemState, disclosureStateKey } from '../ConversationFeedItemState.svelte';

const PERMISSION_OCCURRENCE = 'incarnation-1';

describe('ConversationFeedItemState', () => {
	it('stores only disclosure values that differ from the current default', () => {
		const items = new ConversationFeedItemState();
		items.reconcile('chat-1:generation-1', new Set(['row-1']), new Set());
		const disclosure = items.disclosurePort('row-1');

		expect(disclosure.open('thinking', 'thinking', true)).toBe(true);
		disclosure.setOpen('thinking', 'thinking', false, true);
		expect(disclosure.open('thinking', 'thinking', true)).toBe(false);
		disclosure.setOpen('thinking', 'thinking', true, true);
		expect(disclosure.open('thinking', 'thinking', false)).toBe(false);
	});

	it('keeps input and result disclosures independent', () => {
		const items = new ConversationFeedItemState();
		items.reconcile('chat-1:generation-1', new Set(['row-1']), new Set());
		const disclosure = items.disclosurePort('row-1');
		disclosure.setOpen('tool-input', 'tool-1', true, false);

		expect(disclosure.open('tool-input', 'tool-1', false)).toBe(true);
		expect(disclosure.open('tool-result', 'tool-1', false)).toBe(false);
	});

	it('preserves permission drafts across ordinary row remounts', () => {
		const items = new ConversationFeedItemState();
		items.reconcile('chat-1:generation-1', new Set(['row-1']), new Set([PERMISSION_OCCURRENCE]));
		items.setPermissionDraft(PERMISSION_OCCURRENCE, {
			selectedQuestionOptions: { question: ['answer'] },
			rawInputOpen: true,
		});

		expect(items.permissionDraft(PERMISSION_OCCURRENCE)).toEqual({
			selectedQuestionOptions: { question: ['answer'] },
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
			rawInputOpen: false,
		});
		items.setPermissionDraft(second, {
			selectedQuestionOptions: { database: ['SQLite'] },
			rawInputOpen: true,
		});

		expect(items.permissionDraft(first)).toEqual({
			selectedQuestionOptions: { database: ['Postgres'] },
			rawInputOpen: false,
		});
		expect(items.permissionDraft(second)).toEqual({
			selectedQuestionOptions: { database: ['SQLite'] },
			rawInputOpen: true,
		});

		items.reconcile('chat-1:generation-1', new Set(), new Set([second]));

		expect(items.permissionDraft(first).selectedQuestionOptions).toEqual({});
		expect(items.permissionDraft(second).selectedQuestionOptions).toEqual({
			database: ['SQLite'],
		});
	});

	it('prunes rows and resolved permissions from the active data window', () => {
		const items = new ConversationFeedItemState();
		items.reconcile('chat-1:generation-1', new Set(['row-1']), new Set([PERMISSION_OCCURRENCE]));
		items.setDisclosureOpen(disclosureStateKey('row-1', 'compaction', 'summary'), true, false);
		items.setPermissionDraft(PERMISSION_OCCURRENCE, {
			selectedQuestionOptions: { question: ['answer'] },
			rawInputOpen: true,
		});
		items.reconcile('chat-1:generation-1', new Set(), new Set());

		expect(items.disclosureOpen(disclosureStateKey('row-1', 'compaction', 'summary'), false)).toBe(
			false,
		);
		expect(items.permissionDraft(PERMISSION_OCCURRENCE)).toEqual({
			selectedQuestionOptions: {},
			rawInputOpen: false,
		});
	});

	it('clears all presentation state across chat or generation identity changes', () => {
		const items = new ConversationFeedItemState();
		items.reconcile('chat-1:generation-1', new Set(['row-1']), new Set([PERMISSION_OCCURRENCE]));
		items.disclosurePort('row-1').setOpen('thinking', 'thinking', false, true);
		items.setPermissionDraft(PERMISSION_OCCURRENCE, {
			selectedQuestionOptions: { question: ['answer'] },
			rawInputOpen: true,
		});
		items.reconcile('chat-2:generation-1', new Set(['row-1']), new Set([PERMISSION_OCCURRENCE]));

		expect(items.disclosurePort('row-1').open('thinking', 'thinking', true)).toBe(true);
		expect(items.permissionDraft(PERMISSION_OCCURRENCE).selectedQuestionOptions).toEqual({});
	});
});
