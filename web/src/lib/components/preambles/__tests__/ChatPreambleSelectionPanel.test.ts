import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppShellStore } from '$lib/stores/app-shell.svelte';
import type {
	Preamble,
	PreambleId,
	PreambleSelectionProjection,
	PreamblesSnapshot,
} from '$shared/preambles';
import ChatPreambleSelectionTestHost from './ChatPreambleSelectionTestHost.svelte';

const ID_ELIGIBLE: PreambleId = '3502b645-222b-49d2-ac39-1c91f9fb1174';
const ID_DISABLED: PreambleId = '80becfa6-c9c7-4b31-9190-fd23c0bedf9c';
const ID_SCOPED: PreambleId = '936903ad-8b98-43eb-a7d4-c17ce0dc18d8';
const ID_MISSING: PreambleId = 'fd16ec93-5395-4edc-9a57-7808203f73c7';

function slot(name: string): HTMLElement {
	const element = document.querySelector<HTMLElement>(`[data-slot="${name}"]`);
	if (!element) throw new Error(`Missing data slot: ${name}`);
	return element;
}

function slots(name: string): HTMLElement[] {
	return [...document.querySelectorAll<HTMLElement>(`[data-slot="${name}"]`)];
}

function preamble(
	id: PreambleId,
	title: string,
	overrides: Partial<Preamble> = {},
): Preamble {
	return {
		id,
		enabled: true,
		title,
		content: `Synthetic body for ${title}`,
		scope: { type: 'global' },
		createdAt: '2029-01-01T00:00:00.000Z',
		updatedAt: '2029-01-01T00:00:00.000Z',
		...overrides,
	};
}

function snapshot(): PreamblesSnapshot {
	return {
		revision: 4,
		preambles: [
			preamble(ID_ELIGIBLE, 'Eligible conventions'),
			preamble(ID_DISABLED, 'Disabled conventions', { enabled: false }),
			preamble(ID_SCOPED, 'Scoped conventions', {
				scope: {
					type: 'project-paths',
					rules: [{ projectPath: '/workspace/other', includeNested: true }],
				},
			}),
		],
	};
}

const unavailableProjection: PreambleSelectionProjection = {
	catalogRevision: 4,
	eligiblePreambles: [],
	unavailable: [
		{ id: ID_MISSING, reason: 'missing' },
		{ id: ID_DISABLED, reason: 'disabled' },
	],
};

afterEach(() => cleanup());

describe('ChatPreambleSelectionPanel', () => {
	it('renders retained missing selections and counts only eligible rows', async () => {
		const remove = vi.fn();
		render(ChatPreambleSelectionTestHost, {
			snapshot: snapshot(),
			draftIds: [ID_MISSING, ID_DISABLED],
			projection: unavailableProjection,
			onRemove: remove,
		});

		expect(screen.getByText('None enabled')).toBeTruthy();
		const rows = slots('chat-preamble-selection-row');
		expect(rows).toHaveLength(2);
		expect(rows[0]!.querySelector('[data-slot="chat-preamble-selection-row-status"]')?.textContent)
			.toBe('Deleted or unavailable');
		expect(rows[1]!.querySelector('[data-slot="chat-preamble-selection-row-status"]')?.textContent)
			.toBe('Disabled globally');
		await fireEvent.click(within(rows[0]!).getByRole('button', { name: /Remove/ }));
		expect(remove).toHaveBeenCalledWith(ID_MISSING);
	});

	it('labels disabled and out-of-scope candidates and prevents adding them', async () => {
		render(ChatPreambleSelectionTestHost, {
			snapshot: snapshot(),
			draftIds: [ID_ELIGIBLE],
			projection: {
				catalogRevision: 4,
				eligiblePreambles: [{ id: ID_ELIGIBLE, title: 'Eligible conventions' }],
				unavailable: [],
			},
		});

		await fireEvent.click(slot('chat-preamble-selection-toggle-candidates'));
		const candidates = slots('chat-preamble-selection-candidate');
		const disabled = candidates.find((row) => row.textContent?.includes('Disabled conventions'))!;
		const scoped = candidates.find((row) => row.textContent?.includes('Scoped conventions'))!;
		expect(within(disabled).getByText('Disabled globally')).toBeTruthy();
		expect(within(scoped).getByText('Outside this project')).toBeTruthy();
		expect((within(disabled).getByRole('button') as HTMLButtonElement).disabled).toBe(true);
		expect((within(scoped).getByRole('button') as HTMLButtonElement).disabled).toBe(true);
	});
});

describe('NewChatPreamblePicker', () => {
	it('uses the same gate for Ctrl+Enter and Apply', async () => {
		const apply = vi.fn();
		const close = vi.fn();
		render(ChatPreambleSelectionTestHost, {
			mode: 'new-chat',
			snapshot: snapshot(),
			draftIds: [ID_ELIGIBLE],
			defaultsIds: [ID_ELIGIBLE],
			onApplyExplicit: apply,
			onClose: close,
		});

		const dialog = slot('new-chat-preamble-selection-dialog');
		await fireEvent.keyDown(dialog, { key: 'Enter', ctrlKey: true });
		expect(apply).toHaveBeenCalledWith([ID_ELIGIBLE]);
		expect(close).toHaveBeenCalledOnce();
	});

	it('suspends for catalog management, preserves the draft, and restores focus', async () => {
		let appShell!: AppShellStore;
		const close = vi.fn();
		render(ChatPreambleSelectionTestHost, {
			mode: 'new-chat',
			snapshot: snapshot(),
			draftIds: [ID_ELIGIBLE, ID_DISABLED],
			defaultsIds: [ID_ELIGIBLE, ID_DISABLED],
			onClose: close,
			onAppShell: (value) => { appShell = value; },
		});

		const selectedRows = slots('chat-preamble-selection-row');
		await fireEvent.click(
			within(selectedRows[0]!).getByRole('button', { name: /Remove/ }),
		);
		await fireEvent.click(slot('new-chat-preamble-manage-catalog'));
		expect(appShell.showPreambles).toBe(true);
		await waitFor(() => {
			expect(document.querySelector('[data-slot="new-chat-preamble-selection-dialog"]')).toBeNull();
		});
		expect(close).not.toHaveBeenCalled();

		appShell.closePreambles();
		await waitFor(() => {
			expect(slot('new-chat-preamble-selection-dialog')).toBeTruthy();
			expect(slots('chat-preamble-selection-row')).toHaveLength(1);
			expect(document.activeElement).toBe(
				slot('new-chat-preamble-manage-catalog'),
			);
		});
	});
});
