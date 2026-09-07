import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppShellStore } from '$lib/stores/app-shell.svelte';
import type { PreambleSelectionPreviewResponse } from '$lib/api/chat-preambles.js';
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

function slotText(root: HTMLElement, name: string): string {
	return root.querySelector<HTMLElement>(`[data-slot="${name}"]`)?.textContent?.trim() ?? '';
}

function preamble(id: PreambleId, title: string, overrides: Partial<Preamble> = {}): Preamble {
	return {
		id,
		enabled: true,
		title,
		content: `Synthetic body for ${title}`,
		scope: { type: 'global' },
		agentIds: [],
		tagFilter: { mode: 'any', tags: [] },
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

function resolvedProjection(ids: readonly PreambleId[]): PreambleSelectionProjection {
	const preambles = snapshot().preambles;
	return {
		catalogRevision: 4,
		eligiblePreambles: ids.map((id) => {
			const entry = preambles.find((preamble) => preamble.id === id);
			if (!entry) throw new Error(`Missing test preamble: ${id}`);
			return { id, title: entry.title };
		}),
		unavailable: [],
	};
}

function automaticPreviewResponse(ids: readonly PreambleId[]): PreambleSelectionPreviewResponse {
	return {
		success: true,
		canonicalProjectPath: '/workspace/project',
		orderedPreambleIds: [...ids],
		projection: resolvedProjection(ids),
	};
}

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
		expect(rows).toHaveLength(3);
		const disabledRow = rows.find((row) => row.textContent?.includes('Disabled conventions'))!;
		expect(within(disabledRow).getByText('Disabled conventions').getAttribute('title')).toBe(
			'Disabled globally',
		);
		expect(disabledRow.getAttribute('title')).toBeNull();
		const missingRow = slot('chat-preamble-selection-missing-row');
		expect(within(missingRow).getByText('Deleted or unavailable')).toBeTruthy();
		await fireEvent.click(within(missingRow).getByRole('switch', { name: /Remove/ }));
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

		const candidates = slots('chat-preamble-selection-row');
		const disabled = candidates.find((row) => row.textContent?.includes('Disabled conventions'))!;
		const scoped = candidates.find((row) => row.textContent?.includes('Scoped conventions'))!;
		expect(within(disabled).getByText('Disabled conventions').getAttribute('title')).toBe(
			'Disabled globally',
		);
		expect(within(scoped).getByText('Scoped conventions').getAttribute('title')).toBe(
			'Outside this project',
		);
		expect(document.querySelector('[data-slot="chat-preamble-selection-row-status"]')).toBeNull();
		expect((within(disabled).getByRole('switch') as HTMLButtonElement).disabled).toBe(true);
		expect((within(scoped).getByRole('switch') as HTMLButtonElement).disabled).toBe(true);
	});

	it('scopes unavailable reason descriptions to each panel instance', () => {
		for (let index = 0; index < 2; index += 1) {
			render(ChatPreambleSelectionTestHost, {
				snapshot: snapshot(),
				draftIds: [ID_ELIGIBLE],
				projection: resolvedProjection([ID_ELIGIBLE]),
			});
		}

		const reasonIds = slots('chat-preamble-selection-row')
			.filter((row) => row.textContent?.includes('Disabled conventions'))
			.map((row) => within(row).getByRole('switch').getAttribute('aria-describedby'));
		expect(reasonIds).toHaveLength(2);
		expect(new Set(reasonIds).size).toBe(2);
		for (const reasonId of reasonIds) {
			if (!reasonId) throw new Error('Unavailable switch is missing its reason description');
			expect(document.getElementById(reasonId)?.textContent?.trim()).toBe('Disabled globally');
		}
	});

	it('keeps catalog row order while exposing selected order and switch membership', async () => {
		const move = vi.fn();
		const remove = vi.fn();
		render(ChatPreambleSelectionTestHost, {
			snapshot: snapshot(),
			draftIds: [ID_DISABLED, ID_ELIGIBLE],
			projection: {
				catalogRevision: 4,
				eligiblePreambles: [{ id: ID_ELIGIBLE, title: 'Eligible conventions' }],
				unavailable: [{ id: ID_DISABLED, reason: 'disabled' }],
			},
			onMove: move,
			onRemove: remove,
		});

		const rows = slots('chat-preamble-selection-row');
		expect(rows.map((row) => slotText(row, 'chat-preamble-selection-row-title'))).toEqual([
			'Eligible conventions',
			'Disabled conventions',
			'Scoped conventions',
		]);
		expect(document.querySelector('[data-slot="chat-preamble-selection-row-position"]')).toBeNull();
		await fireEvent.click(within(rows[0]!).getByRole('button', { name: /Move Eligible.*up/ }));
		expect(move).toHaveBeenCalledWith(ID_ELIGIBLE, 'up');
		const disabledSwitch = within(rows[1]!).getByRole('switch') as HTMLButtonElement;
		expect(disabledSwitch.disabled).toBe(false);
		await fireEvent.click(disabledSwitch);
		expect(remove).toHaveBeenCalledWith(ID_DISABLED);
	});
});

describe('NewChatPreamblePicker', () => {
	it('keeps untouched defaults automatic for Ctrl+Enter and Apply', async () => {
		const apply = vi.fn();
		const close = vi.fn();
		render(ChatPreambleSelectionTestHost, {
			mode: 'new-chat',
			snapshot: snapshot(),
			draftIds: [ID_ELIGIBLE],
			defaultsIds: [ID_ELIGIBLE],
			projection: resolvedProjection([ID_ELIGIBLE]),
			onApplyExplicit: apply,
			onClose: close,
		});

		const dialog = slot('new-chat-preamble-selection-dialog');
		await fireEvent.keyDown(dialog, { key: 'Enter', ctrlKey: true });
		expect(apply).not.toHaveBeenCalled();
		expect(close).toHaveBeenCalledOnce();
	});

	it('freezes a touched draft through the shared keyboard submission gate', async () => {
		const apply = vi.fn();
		render(ChatPreambleSelectionTestHost, {
			mode: 'new-chat',
			snapshot: snapshot(),
			draftIds: [ID_ELIGIBLE],
			defaultsIds: [ID_ELIGIBLE],
			projection: resolvedProjection([ID_ELIGIBLE]),
			onApplyExplicit: apply,
		});

		const eligibleRow = slots('chat-preamble-selection-row').find((row) =>
			row.textContent?.includes('Eligible conventions'),
		)!;
		await fireEvent.click(within(eligibleRow).getByRole('switch', { name: /Remove/ }));
		await fireEvent.keyDown(slot('new-chat-preamble-selection-dialog'), {
			key: 'Enter',
			ctrlKey: true,
		});
		expect(apply).toHaveBeenCalledWith([]);
	});

	it('keeps Reset to defaults local until Apply', async () => {
		const applyDefaults = vi.fn();
		const close = vi.fn();
		const loadAutomaticPreview = vi.fn().mockResolvedValue(automaticPreviewResponse([ID_ELIGIBLE]));
		render(ChatPreambleSelectionTestHost, {
			mode: 'new-chat',
			snapshot: snapshot(),
			draftIds: [ID_DISABLED],
			choice: { mode: 'explicit', orderedPreambleIds: [ID_DISABLED] },
			projection: unavailableProjection,
			onApplyDefaults: applyDefaults,
			onLoadAutomaticPreview: loadAutomaticPreview,
			onClose: close,
		});

		await fireEvent.click(slot('new-chat-preamble-reset-defaults'));
		await waitFor(() => {
			const eligibleRow = slots('chat-preamble-selection-row').find((row) =>
				row.textContent?.includes('Eligible conventions'),
			)!;
			expect(within(eligibleRow).getByRole('switch').getAttribute('aria-checked')).toBe('true');
		});
		expect(loadAutomaticPreview).toHaveBeenCalledOnce();
		expect(applyDefaults).not.toHaveBeenCalled();
		expect(close).not.toHaveBeenCalled();

		await fireEvent.click(slot('new-chat-preamble-apply'));
		expect(applyDefaults).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledOnce();
	});

	it('disables Reset to defaults when an automatic preview cannot be loaded', async () => {
		const loadAutomaticPreview = vi.fn();
		render(ChatPreambleSelectionTestHost, {
			mode: 'new-chat',
			snapshot: snapshot(),
			draftIds: [ID_DISABLED],
			choice: { mode: 'explicit', orderedPreambleIds: [ID_DISABLED] },
			projection: unavailableProjection,
			canLoadAutomaticPreview: false,
			onLoadAutomaticPreview: loadAutomaticPreview,
		});

		const reset = slot('new-chat-preamble-reset-defaults') as HTMLButtonElement;
		expect(reset.disabled).toBe(true);
		await fireEvent.click(reset);
		expect(loadAutomaticPreview).not.toHaveBeenCalled();
		expect(document.querySelector('[data-slot="new-chat-preamble-preview-retry"]')).toBeNull();
	});

	it('discards a local Reset to defaults on Cancel', async () => {
		const applyDefaults = vi.fn();
		const close = vi.fn();
		render(ChatPreambleSelectionTestHost, {
			mode: 'new-chat',
			snapshot: snapshot(),
			draftIds: [ID_DISABLED],
			choice: { mode: 'explicit', orderedPreambleIds: [ID_DISABLED] },
			projection: unavailableProjection,
			onApplyDefaults: applyDefaults,
			onLoadAutomaticPreview: async () => automaticPreviewResponse([ID_ELIGIBLE]),
			onClose: close,
		});

		await fireEvent.click(slot('new-chat-preamble-reset-defaults'));
		await waitFor(() => {
			expect((slot('new-chat-preamble-apply') as HTMLButtonElement).disabled).toBe(false);
		});
		await fireEvent.click(slot('new-chat-preamble-cancel'));

		expect(applyDefaults).not.toHaveBeenCalled();
		expect(close).toHaveBeenCalledOnce();
	});

	it('discards a pending Reset preview when the picker closes and reopens', async () => {
		let resolveAutomaticPreview!: (preview: PreambleSelectionPreviewResponse) => void;
		const loadAutomaticPreview = vi.fn(
			() =>
				new Promise<PreambleSelectionPreviewResponse>((resolve) => {
					resolveAutomaticPreview = resolve;
				}),
		);
		const rendered = render(ChatPreambleSelectionTestHost, {
			mode: 'new-chat',
			snapshot: snapshot(),
			draftIds: [ID_DISABLED],
			choice: { mode: 'explicit', orderedPreambleIds: [ID_DISABLED] },
			projection: unavailableProjection,
			onLoadAutomaticPreview: loadAutomaticPreview,
		});

		await fireEvent.click(slot('new-chat-preamble-reset-defaults'));
		await rendered.rerender({ pickerOpen: false });
		await rendered.rerender({ pickerOpen: true });
		resolveAutomaticPreview(automaticPreviewResponse([ID_ELIGIBLE]));

		await waitFor(() => {
			const rows = slots('chat-preamble-selection-row');
			const eligibleRow = rows.find((row) => row.textContent?.includes('Eligible conventions'))!;
			const disabledRow = rows.find((row) => row.textContent?.includes('Disabled conventions'))!;
			expect(within(eligibleRow).getByRole('switch').getAttribute('aria-checked')).toBe('false');
			expect(within(disabledRow).getByRole('switch').getAttribute('aria-checked')).toBe('true');
		});
	});

	it('keeps Apply disabled and offers Retry when a local defaults preview fails', async () => {
		const close = vi.fn();
		const loadAutomaticPreview = vi
			.fn()
			.mockRejectedValueOnce(new Error('preview unavailable'))
			.mockResolvedValueOnce(automaticPreviewResponse([ID_ELIGIBLE]));
		render(ChatPreambleSelectionTestHost, {
			mode: 'new-chat',
			snapshot: snapshot(),
			draftIds: [ID_DISABLED],
			choice: { mode: 'explicit', orderedPreambleIds: [ID_DISABLED] },
			projection: unavailableProjection,
			onLoadAutomaticPreview: loadAutomaticPreview,
			onClose: close,
		});

		await fireEvent.click(slot('new-chat-preamble-reset-defaults'));
		await waitFor(() => {
			expect(slot('new-chat-preamble-preview-status').getAttribute('role')).toBe('alert');
			expect((slot('new-chat-preamble-apply') as HTMLButtonElement).disabled).toBe(true);
		});
		await fireEvent.click(slot('new-chat-preamble-preview-retry'));
		await waitFor(() => {
			expect((slot('new-chat-preamble-apply') as HTMLButtonElement).disabled).toBe(false);
		});
		expect(loadAutomaticPreview).toHaveBeenCalledTimes(2);
		expect(close).not.toHaveBeenCalled();
	});

	it('follows refreshed defaults through catalog management while untouched', async () => {
		let appShell!: AppShellStore;
		const apply = vi.fn();
		const rendered = render(ChatPreambleSelectionTestHost, {
			mode: 'new-chat',
			snapshot: snapshot(),
			draftIds: [ID_ELIGIBLE],
			defaultsIds: [ID_ELIGIBLE],
			canonicalProjectPath: '/workspace/other',
			projection: resolvedProjection([ID_ELIGIBLE]),
			onApplyExplicit: apply,
			onAppShell: (value) => {
				appShell = value;
			},
		});

		await fireEvent.click(slot('new-chat-preamble-manage-catalog'));
		await rendered.rerender({
			defaultsIds: [ID_ELIGIBLE, ID_SCOPED],
			projection: resolvedProjection([ID_ELIGIBLE, ID_SCOPED]),
		});
		appShell.closePreambles();

		await waitFor(() => {
			const scopedRow = slots('chat-preamble-selection-row').find((row) =>
				row.textContent?.includes('Scoped conventions'),
			)!;
			expect(within(scopedRow).getByRole('switch').getAttribute('aria-checked')).toBe('true');
		});
		await fireEvent.click(slot('new-chat-preamble-apply'));
		expect(apply).not.toHaveBeenCalled();
	});

	it('retains untouched defaults while a refreshed preview is pending', async () => {
		const apply = vi.fn();
		const rendered = render(ChatPreambleSelectionTestHost, {
			mode: 'new-chat',
			snapshot: snapshot(),
			draftIds: [ID_ELIGIBLE],
			defaultsIds: [ID_ELIGIBLE],
			canonicalProjectPath: '/workspace/other',
			projection: resolvedProjection([ID_ELIGIBLE]),
			onApplyExplicit: apply,
		});

		await rendered.rerender({ defaultsIds: [], previewLoading: true, projection: null });
		const pendingRows = slots('chat-preamble-selection-row');
		const pendingEligibleRow = pendingRows.find((row) =>
			row.textContent?.includes('Eligible conventions'),
		)!;
		const pendingScopedRow = pendingRows.find((row) =>
			row.textContent?.includes('Scoped conventions'),
		)!;
		expect(within(pendingEligibleRow).getByRole('switch').getAttribute('aria-checked')).toBe(
			'true',
		);
		expect((within(pendingScopedRow).getByRole('switch') as HTMLButtonElement).disabled).toBe(true);

		await fireEvent.click(within(pendingScopedRow).getByRole('switch'));
		await rendered.rerender({
			defaultsIds: [ID_ELIGIBLE, ID_SCOPED],
			previewLoading: false,
			projection: resolvedProjection([ID_ELIGIBLE, ID_SCOPED]),
		});

		await waitFor(() => {
			const resolvedRows = slots('chat-preamble-selection-row');
			const resolvedScopedRow = resolvedRows.find((row) =>
				row.textContent?.includes('Scoped conventions'),
			)!;
			expect(within(resolvedScopedRow).getByRole('switch').getAttribute('aria-checked')).toBe(
				'true',
			);
		});
		await fireEvent.click(slot('new-chat-preamble-apply'));
		expect(apply).not.toHaveBeenCalled();
	});

	it('retains untouched defaults and offers retry after preview refresh fails', async () => {
		const apply = vi.fn();
		const refresh = vi.fn();
		const rendered = render(ChatPreambleSelectionTestHost, {
			mode: 'new-chat',
			snapshot: snapshot(),
			draftIds: [ID_ELIGIBLE],
			defaultsIds: [ID_ELIGIBLE],
			canonicalProjectPath: '/workspace/other',
			projection: resolvedProjection([ID_ELIGIBLE]),
			onApplyExplicit: apply,
			onRefreshPreview: refresh,
		});

		await rendered.rerender({ defaultsIds: [], previewLoading: true, projection: null });
		await rendered.rerender({ defaultsIds: [], previewLoading: false, projection: null });

		const failedRows = slots('chat-preamble-selection-row');
		const failedEligibleRow = failedRows.find((row) =>
			row.textContent?.includes('Eligible conventions'),
		)!;
		const failedScopedRow = failedRows.find((row) =>
			row.textContent?.includes('Scoped conventions'),
		)!;
		expect(within(failedEligibleRow).getByRole('switch').getAttribute('aria-checked')).toBe('true');
		expect((within(failedScopedRow).getByRole('switch') as HTMLButtonElement).disabled).toBe(true);
		expect(slot('new-chat-preamble-preview-status').getAttribute('role')).toBe('alert');

		await fireEvent.click(slot('new-chat-preamble-preview-retry'));
		expect(refresh).toHaveBeenCalledOnce();
		await fireEvent.click(slot('new-chat-preamble-apply'));
		expect(apply).not.toHaveBeenCalled();
	});

	it('suspends for catalog management, preserves the draft, and restores focus', async () => {
		let appShell!: AppShellStore;
		const close = vi.fn();
		render(ChatPreambleSelectionTestHost, {
			mode: 'new-chat',
			snapshot: snapshot(),
			draftIds: [ID_ELIGIBLE, ID_DISABLED],
			defaultsIds: [ID_ELIGIBLE, ID_DISABLED],
			projection: resolvedProjection([ID_ELIGIBLE]),
			onClose: close,
			onAppShell: (value) => {
				appShell = value;
			},
		});

		const selectedRows = slots('chat-preamble-selection-row');
		const eligibleRow = selectedRows.find((row) =>
			row.textContent?.includes('Eligible conventions'),
		)!;
		await fireEvent.click(within(eligibleRow).getByRole('switch', { name: /Remove/ }));
		await fireEvent.click(slot('new-chat-preamble-manage-catalog'));
		expect(appShell.showPreambles).toBe(true);
		await waitFor(() => {
			expect(document.querySelector('[data-slot="new-chat-preamble-selection-dialog"]')).toBeNull();
		});
		expect(close).not.toHaveBeenCalled();

		appShell.closePreambles();
		await waitFor(() => {
			expect(slot('new-chat-preamble-selection-dialog')).toBeTruthy();
			const returnedEligibleRow = slots('chat-preamble-selection-row').find((row) =>
				row.textContent?.includes('Eligible conventions'),
			)!;
			expect(within(returnedEligibleRow).getByRole('switch').getAttribute('aria-checked')).toBe(
				'false',
			);
			expect(document.activeElement).toBe(slot('new-chat-preamble-manage-catalog'));
		});
	});

	it('restores focus before refreshing a local defaults draft', async () => {
		let appShell!: AppShellStore;
		let resolveRefresh!: (preview: PreambleSelectionPreviewResponse) => void;
		const loadAutomaticPreview = vi
			.fn()
			.mockResolvedValueOnce(automaticPreviewResponse([ID_ELIGIBLE]))
			.mockReturnValueOnce(
				new Promise<PreambleSelectionPreviewResponse>((resolve) => {
					resolveRefresh = resolve;
				}),
			);
		render(ChatPreambleSelectionTestHost, {
			mode: 'new-chat',
			snapshot: snapshot(),
			draftIds: [ID_DISABLED],
			choice: { mode: 'explicit', orderedPreambleIds: [ID_DISABLED] },
			projection: unavailableProjection,
			onLoadAutomaticPreview: loadAutomaticPreview,
			onAppShell: (value) => {
				appShell = value;
			},
		});

		await fireEvent.click(slot('new-chat-preamble-reset-defaults'));
		await waitFor(() => {
			expect((slot('new-chat-preamble-apply') as HTMLButtonElement).disabled).toBe(false);
		});
		await fireEvent.click(slot('new-chat-preamble-manage-catalog'));
		appShell.closePreambles();

		await waitFor(() => {
			expect(loadAutomaticPreview).toHaveBeenCalledTimes(2);
			expect(document.activeElement).toBe(slot('new-chat-preamble-manage-catalog'));
		});
		resolveRefresh(automaticPreviewResponse([ID_ELIGIBLE]));
	});
});
