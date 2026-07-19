import { describe, expect, it } from 'vitest';
import type { ChatQueueState, QueueEntry } from '$lib/types/chat';
import { QueuedInputEditorTestHost } from './queued-input-editor-test-host.svelte';

function entry(revision = 1, content = 'Original message'): QueueEntry {
	return {
		id: 'entry-1',
		content,
		revision,
		createdAt: '2026-07-16T00:00:00.000Z',
		updatedAt: '2026-07-16T00:00:00.000Z',
	};
}

function queue(entries: QueueEntry[], overrides: Partial<ChatQueueState> = {}): ChatQueueState {
	return {
		entries,
		dispatchingEntryId: null,
		recentlyDispatched: [],
		pause: null,
		...overrides,
	};
}

describe('QueuedInputEditorState', () => {
	it('preserves the local draft while live snapshots change', () => {
		const host = new QueuedInputEditorTestHost(queue([entry()]));
		const editor = host.editor;
		editor.begin(host.queue!.entries[0]);
		editor.draft = 'My unsaved draft';

		host.queue = queue([entry(2, 'Edited elsewhere')]);

		expect(editor.phase).toBe('conflict');
		expect(editor.draft).toBe('My unsaved draft');
		expect(editor.liveEntry?.content).toBe('Edited elsewhere');
	});

	it('reloads or rebases explicitly after a revision conflict', () => {
		const host = new QueuedInputEditorTestHost(queue([entry()]));
		const editor = host.editor;
		editor.begin(host.queue!.entries[0]);
		editor.draft = 'Local draft';
		host.queue = queue([entry(2, 'Latest content')]);

		editor.rebaseOnLatest();
		expect(editor.phase).toBe('editable');
		expect(editor.draft).toBe('Local draft');
		expect(editor.baseRevision).toBe(2);

		host.queue = queue([entry(3, 'Newest content')]);
		editor.reloadLatest();
		expect(editor.phase).toBe('editable');
		expect(editor.draft).toBe('Newest content');
		expect(editor.baseRevision).toBe(3);
	});

	it('distinguishes dispatching, sent, and arbitrary removal without losing the draft', () => {
		const host = new QueuedInputEditorTestHost(queue([entry()]));
		const editor = host.editor;
		editor.begin(host.queue!.entries[0]);
		editor.draft = 'Recover this draft';

		host.queue = queue([], { dispatchingEntryId: 'entry-1' });
		expect(editor.phase).toBe('dispatching');

		host.queue = queue([], {
			recentlyDispatched: [{ entryId: 'entry-1', dispatchedAt: '2026-07-16T00:01:00.000Z' }],
		});
		expect(editor.phase).toBe('sent');
		expect(editor.draft).toBe('Recover this draft');

		host.queue = queue([]);
		expect(editor.phase).toBe('removed');
		expect(editor.draft).toBe('Recover this draft');
	});

	it('uses one save predicate for content and mutation state', () => {
		const host = new QueuedInputEditorTestHost(queue([entry()]));
		const editor = host.editor;
		editor.begin(host.queue!.entries[0]);

		expect(editor.canSave).toBe(true);
		editor.draft = '   ';
		expect(editor.canSave).toBe(false);
		editor.draft = 'Updated';
		editor.mutation = 'saving';
		expect(editor.canSave).toBe(false);
	});

	it('keeps an ambiguous queue-as-new outcome scoped to one editor session', () => {
		const host = new QueuedInputEditorTestHost(queue([entry()]));
		const editor = host.editor;
		editor.begin(host.queue!.entries[0]);
		editor.markQueueDraftOutcomeUnknown('Check the queue');

		expect(editor.queueDraftOutcomeUnknown).toBe(true);
		expect(editor.error).toBe('Check the queue');

		editor.close();
		expect(editor.queueDraftOutcomeUnknown).toBe(false);
		expect(editor.error).toBeNull();
	});
});
