import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const controller = vi.hoisted(() => ({
	open: vi.fn(),
	close: vi.fn(),
	save: vi.fn(),
}));

vi.mock('$lib/preambles/chat-selection-controller.svelte.js', () => ({
	ChatPreambleSelectionController: class {
		status = 'ready';
		error = null;
		conflict = false;
		partialWarning = null;
		draftIds = [];
		projection = { catalogRevision: 0, eligiblePreambles: [], unavailable: [] };
		canonicalProjectPath = '/workspace/project';
		saving = false;
		canSave = true;

		open(target: unknown): void {
			controller.open(target);
		}

		close(): void {
			controller.close();
		}

		save(): Promise<void> {
			controller.save();
			return Promise.resolve();
		}

		move(): void {}
		remove(): void {}
		add(): void {}
		refreshBase(): Promise<void> { return Promise.resolve(); }
	},
}));

const ChatPreambleSelectionDialogTestHost = (
	await import('./ChatPreambleSelectionDialogTestHost.svelte')
).default;

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe('ChatPreambleSelectionDialog', () => {
	it('uses the captured target, exposes stable slots, and closes its controller on destruction', async () => {
		const rendered = render(ChatPreambleSelectionDialogTestHost);
		await waitFor(() => expect(controller.open).toHaveBeenCalledWith({
			chatId: '1783725900000200',
			transcriptViewId: 'view-a',
		}));
		const dialog = document.querySelector<HTMLElement>(
			'[data-slot="chat-preamble-selection-dialog"]',
		);
		expect(dialog).not.toBeNull();
		expect(document.querySelector('[data-slot="chat-preamble-selection-scroll-body"]'))
			.not.toBeNull();

		await fireEvent.keyDown(dialog!, { key: 'Enter', metaKey: true });
		expect(controller.save).toHaveBeenCalledOnce();

		rendered.unmount();
		expect(controller.close).toHaveBeenCalledOnce();
	});
});
