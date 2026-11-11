import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as persistence from '$lib/utils/local-persistence';
import { parseChatId, type ChatId } from '$shared/chat-id';
import { NewChatPromptDraft, NewChatPromptDraftStore } from '../new-chat-prompt-draft';

function image(name: string): File {
	return new File(['image'], name, { type: 'image/png' });
}

// Each store is one tab, or one page load of the same tab; each draft is one mount of the form.
function openForm(tab: NewChatPromptDraftStore, prefill = '', prospectiveChatId?: ChatId) {
	const draft = new NewChatPromptDraft(tab);
	return { draft, seeded: draft.seed(prefill, prospectiveChatId) };
}

describe('NewChatPromptDraft', () => {
	afterEach(() => vi.restoreAllMocks());
	let tab: NewChatPromptDraftStore;

	beforeEach(() => {
		localStorage.clear();
		tab = new NewChatPromptDraftStore();
	});

	it('seeds an empty form when nothing is retained', () => {
		expect(openForm(tab).seeded).toEqual({ text: '', attachments: [] });
	});

	it('restores retained text and attachments when the dialog reopens', () => {
		const attachment = image('diagram.png');
		openForm(tab).draft.retain('Unsent prompt', [attachment]);

		expect(openForm(tab).seeded).toEqual({ text: 'Unsent prompt', attachments: [attachment] });
	});

	it('restores retained text, but not attachments, after a page reload', () => {
		openForm(tab).draft.retain('Unsent prompt', [image('diagram.png')]);

		expect(openForm(new NewChatPromptDraftStore()).seeded).toEqual({
			text: 'Unsent prompt',
			attachments: [],
		});
	});

	it('discards the draft once its content starts a chat', () => {
		const { draft } = openForm(tab);
		draft.retain('Sent prompt', [image('diagram.png')]);
		draft.discardSubmitted();

		expect(openForm(tab).seeded).toEqual({ text: '', attachments: [] });
		expect(openForm(new NewChatPromptDraftStore()).seeded?.text).toBe('');
	});

	it('ignores content changes that arrive after the chat has started', () => {
		const { draft } = openForm(tab);
		draft.retain('Sent prompt', []);
		draft.discardSubmitted();
		draft.retain('Sent prompt, late keystroke', []);

		expect(openForm(tab).seeded?.text).toBe('');
	});

	it('drops the stored text when the prompt is emptied', () => {
		const { draft } = openForm(tab);
		draft.retain('Unsent prompt', []);
		draft.retain('', []);

		expect(openForm(new NewChatPromptDraftStore()).seeded?.text).toBe('');
	});

	it('keeps an older unsent draft when a prefilled dialog is edited and submitted', () => {
		const attachment = image('diagram.png');
		openForm(tab).draft.retain('Unsent prompt', [attachment]);

		const prefilled = openForm(tab, 'Prefilled prompt');
		expect(prefilled.seeded).toBeNull();
		prefilled.draft.retain('Prefilled prompt, edited', []);
		prefilled.draft.discardSubmitted();

		expect(openForm(tab).seeded).toEqual({ text: 'Unsent prompt', attachments: [attachment] });
	});

	it('retains an edited prefill when no older draft exists', () => {
		openForm(tab, 'Prefilled prompt').draft.retain('Prefilled prompt, edited', []);

		expect(openForm(tab).seeded?.text).toBe('Prefilled prompt, edited');
	});

	it('does not retain a prefill that was never edited', () => {
		openForm(tab, 'Prefilled prompt');

		expect(openForm(tab).seeded?.text).toBe('');
	});

	it.each(['seeded', 'lazy'] as const)('retains a %s chat ID with edited text across reopen and reload', source => {
		const seededId = parseChatId('1000000000000001');
		const { draft } = source === 'seeded'
			? openForm(tab, `Review ${seededId}`, seededId)
			: openForm(tab);
		const id = draft.ensureProspectiveChatId();
		if (source === 'seeded') expect(id).toBe(seededId);
		draft.retain(`Edited review ${id}`, [image('diagram.png')]);
		const reopened = openForm(tab);
		expect(reopened.draft.ensureProspectiveChatId()).toBe(id);
		expect(reopened.seeded?.attachments).toHaveLength(1);
		const reloaded = openForm(new NewChatPromptDraftStore());
		expect(reloaded.seeded).toEqual({ text: `Edited review ${id}`, attachments: [], prospectiveChatId: id });
		expect(reloaded.draft.ensureProspectiveChatId()).toBe(id);
	});

	it('preserves the older draft ID while a separate prefill is edited and submitted', () => {
		const older = openForm(tab).draft;
		const olderId = older.ensureProspectiveChatId();
		older.retain(`Older ${olderId}`, []);
		const prefilledId = parseChatId('1000000000000001');
		const prefilled = openForm(tab, `Prefill ${prefilledId}`, prefilledId).draft;
		expect(prefilled.ensureProspectiveChatId()).toBe(prefilledId);
		prefilled.retain(`Edited ${prefilledId}`, []);
		prefilled.discardSubmitted();
		expect(openForm(tab).draft.ensureProspectiveChatId()).toBe(olderId);
	});

	it('keeps the retained text bound to its ID when an empty prefill supplies another ID', () => {
		const { draft } = openForm(tab);
		const id = draft.ensureProspectiveChatId();
		draft.retain(`Review ${id}`, []);
		const reopened = openForm(tab, '', parseChatId('1000000000000001'));
		expect(reopened.seeded?.text).toBe(`Review ${id}`);
		expect(reopened.draft.ensureProspectiveChatId()).toBe(id);
	});

	it.each(['empty', 'submit'] as const)('clears the persisted ID on %s', action => {
		const { draft } = openForm(tab);
		draft.ensureProspectiveChatId();
		draft.retain('Unsent prompt', []);
		if (action === 'empty') draft.retain('', []);
		else draft.discardSubmitted();
		expect(openForm(tab).seeded).toEqual({ text: '', attachments: [] });
		expect(openForm(new NewChatPromptDraftStore()).seeded).toEqual({ text: '', attachments: [] });
	});

	it('uses a fresh ID after clearing and retyping in the same form', () => {
		const occupiedId = parseChatId('1000000000000001');
		const { draft } = openForm(tab, `Review ${occupiedId}`, occupiedId);
		draft.retain('', []);
		draft.retain('Replacement prompt', []);
		const replacementId = draft.ensureProspectiveChatId();
		expect(replacementId).not.toBe(occupiedId);
		draft.retain(`Replacement ${replacementId}`, []);
		expect(openForm(new NewChatPromptDraftStore()).draft.ensureProspectiveChatId()).toBe(replacementId);
	});

	it('keeps the ID while attachments remain after clearing text', () => {
		const { draft } = openForm(tab);
		const id = draft.ensureProspectiveChatId();
		draft.retain('', [image('diagram.png')]);
		expect(draft.ensureProspectiveChatId()).toBe(id);
	});

	it('keeps valid text when its stored ID is malformed', () => {
		localStorage.setItem(persistence.chatDraftStorageKey('new-chat'), JSON.stringify({
			text: 'Unsent prompt', prospectiveChatId: 'invalid',
		}));
		expect(openForm(tab).seeded).toEqual({ text: 'Unsent prompt', attachments: [] });
	});

	it('retains the ID in memory when persistence fails', () => {
		vi.spyOn(persistence, 'setLocalStorageItem').mockImplementation(() => {});
		const { draft } = openForm(tab);
		const id = draft.ensureProspectiveChatId();
		draft.retain(`Review ${id}`, []);
		expect(openForm(tab).draft.ensureProspectiveChatId()).toBe(id);
	});

	it('retains text and attachments in memory when storage writes fail', () => {
		vi.spyOn(persistence, 'setLocalStorageItem').mockImplementation(() => {});
		const attachment = image('diagram.png');
		openForm(tab).draft.retain('Unsent prompt', [attachment]);
		expect(openForm(tab).seeded).toEqual({ text: 'Unsent prompt', attachments: [attachment] });
	});

	it('keeps submitted content cleared in memory when storage removal fails', () => {
		const { draft } = openForm(tab);
		draft.retain('Sent prompt', []);
		vi.spyOn(persistence, 'removeLocalStorageItem').mockImplementation(() => {});
		draft.discardSubmitted();
		expect(openForm(tab).seeded).toEqual({ text: '', attachments: [] });
	});

	describe('with a second tab', () => {
		let otherTab: NewChatPromptDraftStore;

		beforeEach(() => {
			otherTab = new NewChatPromptDraftStore();
		});

		it('does not erase another tab replacing the draft with identical text', () => {
			const { draft } = openForm(tab);
			draft.retain('Same prompt', [image('first.png')]);
			const attachment = image('second.png');
			openForm(otherTab).draft.retain('Same prompt', [attachment]);
			draft.discardSubmitted();
			expect(openForm(otherTab).seeded).toEqual({ text: 'Same prompt', attachments: [attachment] });
		});

		it('adopts another tab\'s ID with its replacement text without overwriting it', () => {
			const firstId = parseChatId('1000000000000001');
			const secondId = parseChatId('1000000000000002');
			const first = openForm(tab, 'First', firstId).draft;
			first.retain(`First ${firstId}`, []);
			const second = openForm(otherTab).draft;
			expect(second.ensureProspectiveChatId()).toBe(firstId);
			second.retain('', []);
			openForm(otherTab, 'Second', secondId).draft.retain(`Second ${secondId}`, []);
			first.retain('Stale edit', []);
			first.discardSubmitted();
			const reopened = openForm(tab);
			expect(reopened.seeded?.text).toBe(`Second ${secondId}`);
			expect(reopened.draft.ensureProspectiveChatId()).toBe(secondId);
		});

		it('drops stale attachments when another tab writes identical text', () => {
			openForm(tab).draft.retain('Same prompt', [image('first.png')]);
			openForm(otherTab).draft.retain('Same prompt', [image('second.png')]);
			expect(openForm(tab).seeded).toEqual({ text: 'Same prompt', attachments: [] });
		});

		it('protects an attachment-only draft from a stale empty form submitting', () => {
			const { draft } = openForm(tab);
			const attachment = image('diagram.png');
			openForm(otherTab).draft.retain('', [attachment]);
			draft.discardSubmitted();
			expect(openForm(otherTab).seeded).toEqual({ text: '', attachments: [attachment] });
		});

		it('shows a draft typed in the other tab without a reload', () => {
			openForm(tab);
			openForm(otherTab).draft.retain('Typed in the other tab', []);

			expect(openForm(tab).seeded?.text).toBe('Typed in the other tab');
		});

		it('does not erase a newer draft from the other tab when an empty-seeded form submits', () => {
			const { draft } = openForm(tab);
			openForm(otherTab).draft.retain('Typed in the other tab', []);
			draft.discardSubmitted();

			expect(openForm(otherTab).seeded?.text).toBe('Typed in the other tab');
		});

		it('does not erase a newer draft from the other tab when a prefilled form submits', () => {
			const { draft } = openForm(tab, 'Prefilled prompt');
			openForm(otherTab).draft.retain('Typed in the other tab', []);
			draft.discardSubmitted();

			expect(openForm(otherTab).seeded?.text).toBe('Typed in the other tab');
		});

		it('does not replace or erase a newer draft from the other tab by typing and submitting', () => {
			const { draft } = openForm(tab);
			draft.retain('Typed here first', []);
			openForm(otherTab).draft.retain('Typed in the other tab', []);
			draft.retain('Typed here first, continued', []);
			expect(openForm(otherTab).seeded?.text).toBe('Typed in the other tab');

			draft.discardSubmitted();
			expect(openForm(otherTab).seeded?.text).toBe('Typed in the other tab');
		});

		it('does not pair attachments held by this tab with text from the other tab', () => {
			openForm(tab).draft.retain('Typed here', [image('diagram.png')]);
			openForm(otherTab).draft.retain('Typed in the other tab', []);

			expect(openForm(tab).seeded).toEqual({ text: 'Typed in the other tab', attachments: [] });
		});

		it('clears a draft seeded from the other tab once this tab sends it', () => {
			openForm(otherTab).draft.retain('Typed in the other tab', []);
			openForm(tab).draft.discardSubmitted();

			expect(openForm(otherTab).seeded?.text).toBe('');
		});
	});
});
