import { beforeEach, describe, expect, it } from 'vitest';
import { ChatDraftStore } from '$lib/chat/composer/chat-draft-store.svelte';
import { NewChatPromptDraft } from '../new-chat-prompt-draft';

function image(name: string): File {
	return new File(['image'], name, { type: 'image/png' });
}

// Stands in for the page-hide flush and a fresh page load.
function reload(drafts: ChatDraftStore): ChatDraftStore {
	drafts.destroy();
	return new ChatDraftStore();
}

describe('NewChatPromptDraft', () => {
	let drafts: ChatDraftStore;

	beforeEach(() => {
		localStorage.clear();
		drafts = new ChatDraftStore();
	});

	it('seeds an empty form when nothing is retained', () => {
		expect(new NewChatPromptDraft(drafts).seed('')).toEqual({ text: '', attachments: [] });
	});

	it('restores retained text and attachments when the dialog reopens', () => {
		const closed = new NewChatPromptDraft(drafts);
		closed.seed('');
		const attachment = image('diagram.png');
		closed.retain('Unsent prompt', [attachment]);

		expect(new NewChatPromptDraft(drafts).seed('')).toEqual({
			text: 'Unsent prompt',
			attachments: [attachment],
		});
	});

	it('restores retained text, but not attachments, after a page reload', () => {
		const closed = new NewChatPromptDraft(drafts);
		closed.seed('');
		closed.retain('Unsent prompt', [image('diagram.png')]);

		expect(new NewChatPromptDraft(reload(drafts)).seed('')).toEqual({
			text: 'Unsent prompt',
			attachments: [],
		});
	});

	it('discards the draft once its content starts a chat', () => {
		const submitted = new NewChatPromptDraft(drafts);
		submitted.seed('');
		submitted.retain('Sent prompt', [image('diagram.png')]);
		submitted.discardSubmitted();

		expect(new NewChatPromptDraft(drafts).seed('')).toEqual({ text: '', attachments: [] });
		expect(new NewChatPromptDraft(reload(drafts)).seed('')?.text).toBe('');
	});

	it('ignores content changes that arrive after the chat has started', () => {
		const submitted = new NewChatPromptDraft(drafts);
		submitted.seed('');
		submitted.retain('Sent prompt', []);
		submitted.discardSubmitted();
		submitted.retain('Sent prompt, late keystroke', []);

		expect(new NewChatPromptDraft(reload(drafts)).seed('')?.text).toBe('');
	});

	it('drops the draft when the prompt is emptied', () => {
		const closed = new NewChatPromptDraft(drafts);
		closed.seed('');
		closed.retain('Unsent prompt', []);
		closed.retain('', []);

		expect(new NewChatPromptDraft(reload(drafts)).seed('')?.text).toBe('');
	});

	it('keeps an older unsent draft when a prefilled dialog is edited and submitted', () => {
		const closed = new NewChatPromptDraft(drafts);
		closed.seed('');
		const attachment = image('diagram.png');
		closed.retain('Unsent prompt', [attachment]);

		const prefilled = new NewChatPromptDraft(drafts);
		expect(prefilled.seed('Prefilled prompt')).toBeNull();
		prefilled.retain('Prefilled prompt, edited', []);
		prefilled.discardSubmitted();

		expect(new NewChatPromptDraft(drafts).seed('')).toEqual({
			text: 'Unsent prompt',
			attachments: [attachment],
		});
	});

	it('retains an edited prefill when no older draft exists', () => {
		const prefilled = new NewChatPromptDraft(drafts);
		prefilled.seed('Prefilled prompt');
		prefilled.retain('Prefilled prompt, edited', []);

		expect(new NewChatPromptDraft(reload(drafts)).seed('')?.text).toBe('Prefilled prompt, edited');
	});

	it('does not retain a prefill that was never edited', () => {
		new NewChatPromptDraft(drafts).seed('Prefilled prompt');

		expect(new NewChatPromptDraft(reload(drafts)).seed('')?.text).toBe('');
	});

	it('leaves a draft written by another tab alone when this tab opens and closes untouched', () => {
		new NewChatPromptDraft(drafts).seed('');
		const otherTab = new ChatDraftStore();
		const typedElsewhere = new NewChatPromptDraft(otherTab);
		typedElsewhere.seed('');
		typedElsewhere.retain('Typed in another tab', []);
		otherTab.destroy();

		new NewChatPromptDraft(drafts).seed('');

		expect(new NewChatPromptDraft(reload(drafts)).seed('')?.text).toBe('Typed in another tab');
	});
});
