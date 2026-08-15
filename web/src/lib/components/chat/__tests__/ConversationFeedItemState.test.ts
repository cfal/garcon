import { describe, expect, it } from 'vitest';
import { permissionOccurrenceKey } from '$shared/chat-types';
import { ConversationFeedItemState, disclosureStateKey } from '../ConversationFeedItemState.svelte';

const PERMISSION_ID = 'permission-1';
const INCARNATION = 'incarnation-1';
const PERMISSION_OCCURRENCE = permissionOccurrenceKey(PERMISSION_ID, INCARNATION);

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
		items.setPermissionDraft(PERMISSION_ID, INCARNATION, {
			selectedQuestionOptions: { question: ['answer'] },
			rawInputOpen: true,
		});

		expect(items.permissionDraft(PERMISSION_ID, INCARNATION)).toEqual({
			selectedQuestionOptions: { question: ['answer'] },
			rawInputOpen: true,
		});
	});

	it('keeps drafts independent when a permission request id is reused', () => {
		const items = new ConversationFeedItemState();
		const first = permissionOccurrenceKey(PERMISSION_ID, 'incarnation-1');
		const second = permissionOccurrenceKey(PERMISSION_ID, 'incarnation-2');
		items.reconcile('chat-1:generation-1', new Set(), new Set([first, second]));
		items.setPermissionDraft(PERMISSION_ID, 'incarnation-1', {
			selectedQuestionOptions: { database: ['Postgres'] },
			rawInputOpen: false,
		});
		items.setPermissionDraft(PERMISSION_ID, 'incarnation-2', {
			selectedQuestionOptions: { database: ['SQLite'] },
			rawInputOpen: true,
		});

		expect(items.permissionDraft(PERMISSION_ID, 'incarnation-1')).toEqual({
			selectedQuestionOptions: { database: ['Postgres'] },
			rawInputOpen: false,
		});
		expect(items.permissionDraft(PERMISSION_ID, 'incarnation-2')).toEqual({
			selectedQuestionOptions: { database: ['SQLite'] },
			rawInputOpen: true,
		});

		items.reconcile('chat-1:generation-1', new Set(), new Set([second]));

		expect(items.permissionDraft(PERMISSION_ID, 'incarnation-1').selectedQuestionOptions).toEqual({});
		expect(items.permissionDraft(PERMISSION_ID, 'incarnation-2').selectedQuestionOptions).toEqual({
			database: ['SQLite'],
		});
	});

	it('prunes rows and resolved permissions from the active data window', () => {
		const items = new ConversationFeedItemState();
		items.reconcile('chat-1:generation-1', new Set(['row-1']), new Set([PERMISSION_OCCURRENCE]));
		items.setDisclosureOpen(disclosureStateKey('row-1', 'compaction', 'summary'), true, false);
		items.setPermissionDraft(PERMISSION_ID, INCARNATION, {
			selectedQuestionOptions: { question: ['answer'] },
			rawInputOpen: true,
		});
		items.reconcile('chat-1:generation-1', new Set(), new Set());

		expect(items.disclosureOpen(disclosureStateKey('row-1', 'compaction', 'summary'), false)).toBe(
			false,
		);
		expect(items.permissionDraft(PERMISSION_ID, INCARNATION)).toEqual({
			selectedQuestionOptions: {},
			rawInputOpen: false,
		});
	});

	it('clears all presentation state across chat or generation identity changes', () => {
		const items = new ConversationFeedItemState();
		items.reconcile('chat-1:generation-1', new Set(['row-1']), new Set([PERMISSION_OCCURRENCE]));
		items.disclosurePort('row-1').setOpen('thinking', 'thinking', false, true);
		items.setPermissionDraft(PERMISSION_ID, INCARNATION, {
			selectedQuestionOptions: { question: ['answer'] },
			rawInputOpen: true,
		});
		items.reconcile('chat-2:generation-1', new Set(['row-1']), new Set([PERMISSION_OCCURRENCE]));

		expect(items.disclosurePort('row-1').open('thinking', 'thinking', true)).toBe(true);
		expect(items.permissionDraft(PERMISSION_ID, INCARNATION).selectedQuestionOptions).toEqual({});
	});
});
