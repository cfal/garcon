import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TYPOGRAPHY_SIZE_OPTIONS, TYPOGRAPHY_SURFACES } from '$lib/theme/typography';
import { fontControlLabel } from '$lib/components/shared/typography-labels';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence';
import TypographySettingsTestHost from './TypographySettingsTestHost.svelte';

function saved() {
	return JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings) ?? '{}');
}
async function open(label: string) {
	await fireEvent.click(
		screen.getByRole('button', { name: (name) => name.startsWith(`${label}:`) }),
	);
	return within(await screen.findByRole('dialog', { name: label }));
}

describe('TypographySettings', () => {
	beforeEach(() => localStorage.clear());
	afterEach(cleanup);
	it('offers nine independent rows with concrete default summaries', () => {
		render(TypographySettingsTestHost);
		expect(screen.getAllByRole('button')).toHaveLength(9);
		expect(screen.getByRole('button', { name: /^Interface Font:/ }).textContent).toContain(
			'System UI',
		);
		expect(screen.getByRole('button', { name: /^Interface Font:/ }).textContent).toContain(
			'14px base',
		);
		expect(screen.getByRole('button', { name: /^Code Diffs Font:/ }).textContent).toContain(
			'11-13px',
		);
		expect(
			screen.getByRole('button', { name: /^Expanded Text Editors Font:/ }).textContent,
		).toContain('14px');
		for (const button of screen.getAllByRole('button')) {
			expect(button.getAttribute('aria-label')).toContain(button.textContent?.trim());
		}
	});

	it('applies and restores every font and size pair', async () => {
		const view = render(TypographySettingsTestHost);
		for (const surface of TYPOGRAPHY_SURFACES) {
			const dialog = await open(fontControlLabel(surface.id));
			const size = dialog.getByRole<HTMLSelectElement>('combobox');
			expect(dialog.getByRole<HTMLInputElement>('radio', { name: /\(Default\)/ }).checked).toBe(
				true,
			);
			expect(size.value).toBe('default');
			expect([...size.options].map((option) => option.value)).toEqual([...TYPOGRAPHY_SIZE_OPTIONS]);
			await fireEvent.click(dialog.getByRole('radio', { name: 'JetBrains Mono' }));
			await fireEvent.change(size, { target: { value: '18' } });
			expect(saved()[surface.fontKey]).not.toBe('jetbrains-mono');
			await fireEvent.click(dialog.getByRole('button', { name: 'Apply' }));
			expect(saved()).toMatchObject({
				[surface.fontKey]: 'jetbrains-mono',
				[surface.sizeKey]: '18',
				terminalAppearance: false,
			});
		}
		view.unmount();
		render(TypographySettingsTestHost);
		for (const { id } of TYPOGRAPHY_SURFACES)
			expect(
				screen.getByRole('button', { name: (name) => name.startsWith(`${fontControlLabel(id)}:`) })
					.textContent,
			).toContain('JetBrains Mono');
	});

	it('keeps preview and reset changes local until Apply, and Cancel discards both', async () => {
		localStorage.setItem(
			LOCAL_STORAGE_KEYS.localSettings,
			JSON.stringify({ expandedEditorFont: 'inter', expandedEditorFontSize: '18' }),
		);
		render(TypographySettingsTestHost);
		const before = localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings);
		let dialog = await open('Expanded Text Editors Font');
		await fireEvent.click(dialog.getByRole('radio', { name: 'System serif' }));
		expect(document.querySelector<HTMLElement>('[data-font-preview]')!.style.fontFamily).toBe(
			'var(--font-choice-system-serif)',
		);
		await fireEvent.click(dialog.getByRole('button', { name: 'Reset to default' }));
		expect(dialog.getByRole<HTMLInputElement>('radio', { name: /\(Default\)/ }).checked).toBe(true);
		expect(localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings)).toBe(before);
		await fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
		dialog = await open('Expanded Text Editors Font');
		expect(dialog.getByRole<HTMLInputElement>('radio', { name: 'Inter' }).checked).toBe(true);
		await fireEvent.click(dialog.getByRole('button', { name: 'Reset to default' }));
		await fireEvent.click(dialog.getByRole('button', { name: 'Apply' }));
		expect(saved()).toMatchObject({
			expandedEditorFont: 'default',
			expandedEditorFontSize: 'default',
		});
	});

	it.each(['File Editors Font', 'Expanded Text Editors Font'])(
		'previews the default editor stack for %s',
		async (label) => {
			render(TypographySettingsTestHost);
			await open(label);
			expect(document.querySelector<HTMLElement>('[data-font-preview]')!.style.fontFamily).toBe(
				'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
			);
		},
	);

	it('restricts terminal choices while allowing proportional expanded text', async () => {
		render(TypographySettingsTestHost);
		let dialog = await open('Terminal Font');
		expect(dialog.queryByRole('radio', { name: 'Inter' })).toBeNull();
		expect(dialog.getByRole('radio', { name: 'JetBrains Mono' })).toBeTruthy();
		await fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
		dialog = await open('Expanded Text Editors Font');
		expect(dialog.getByRole('radio', { name: 'Inter' })).toBeTruthy();
	});

	it('previews commands at the default Chat Code size', async () => {
		render(TypographySettingsTestHost);
		const dialog = await open('Chat Code & Commands Font');
		const command = dialog.getByText('$ bun run test');
		expect(command.style.fontSize).toBe('');
		expect(command.closest<HTMLElement>('[data-font-preview]')!.style.fontSize).toBe('12px');
		await fireEvent.change(dialog.getByRole('combobox'), { target: { value: '18' } });
		expect(command.closest<HTMLElement>('[data-font-preview]')!.style.fontSize).toBe('18px');
	});

	it('reflects external changes on rows and reopening without replacing an open draft', async () => {
		render(TypographySettingsTestHost);
		const dialog = await open('File Editors Font');
		localStorage.setItem(
			LOCAL_STORAGE_KEYS.localSettings,
			JSON.stringify({ codeEditorFontSize: '20', expandedEditorFontSize: 'default' }),
		);
		window.dispatchEvent(
			new StorageEvent('storage', {
				key: LOCAL_STORAGE_KEYS.localSettings,
				storageArea: localStorage,
			}),
		);
		expect(dialog.getByRole<HTMLSelectElement>('combobox').value).toBe('default');
		await fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
		await waitFor(() =>
			expect(screen.getByRole('button', { name: /^File Editors Font:/ }).textContent).toContain(
				'20px',
			),
		);
		const reopened = await open('File Editors Font');
		expect(reopened.getByRole<HTMLSelectElement>('combobox').value).toBe('20');
	});
});
