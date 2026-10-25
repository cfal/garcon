import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as persistence from '$lib/utils/local-persistence';
import { NewChatPromptDraft, NewChatPromptDraftStore } from '../new-chat-prompt-draft';

function image(name: string): File {
	return new File(['image'], name, { type: 'image/png' });
}

// Each store is one tab, or one page load of the same tab; each draft is one mount of the form.
function openForm(tab: NewChatPromptDraftStore, prefill = '') {
	const draft = new NewChatPromptDraft(tab);
	return { draft, seeded: draft.seed(prefill) };
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
