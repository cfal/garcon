import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TYPOGRAPHY_SIZE_OPTIONS, TYPOGRAPHY_SURFACES } from '$lib/theme/typography';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence';
import TypographySettingsTestHost from './TypographySettingsTestHost.svelte';

const labels = [
	'Interface',
	'Chat List',
	'Chat Feed',
	'Chat Code & Output',
	'Code Editor',
	'Code Diffs',
	'Terminal',
];

describe('TypographySettings', () => {
	beforeEach(() => localStorage.clear());
	afterEach(cleanup);
	it('offers seven independent font and size pairs and restores every selection', async () => {
		let view = render(TypographySettingsTestHost);
		for (const [index, surface] of TYPOGRAPHY_SURFACES.entries()) {
			const font = screen.getByRole<HTMLSelectElement>('combobox', {
				name: labels[index] + ' Font',
			});
			const size = screen.getByRole<HTMLSelectElement>('combobox', {
				name: labels[index] + ' Font Size',
			});
			expect(font.value).toBe('default');
			expect(size.value).toBe('default');
			expect([...size.options].map((option) => option.value)).toEqual([...TYPOGRAPHY_SIZE_OPTIONS]);
			await fireEvent.change(font, { target: { value: 'departure-mono' } });
			await fireEvent.change(size, { target: { value: '18' } });
			expect(JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings)!)).toMatchObject({
				[surface.fontKey]: 'departure-mono',
				[surface.sizeKey]: '18',
				terminalAppearance: false,
			});
		}
		view.unmount();
		view = render(TypographySettingsTestHost);
		for (const label of labels) {
			expect(screen.getByRole<HTMLSelectElement>('combobox', { name: label + ' Font' }).value).toBe(
				'departure-mono',
			);
			expect(
				screen.getByRole<HTMLSelectElement>('combobox', { name: label + ' Font Size' }).value,
			).toBe('18');
		}
		view.unmount();
	});
	it('reflects size changes from a toolbar or another tab', async () => {
		render(TypographySettingsTestHost);
		const snapshot = { codeEditorFontSize: '20', gitDiffFontSize: '16', terminalFontSize: '15' };
		localStorage.setItem(LOCAL_STORAGE_KEYS.localSettings, JSON.stringify(snapshot));
		window.dispatchEvent(
			new StorageEvent('storage', {
				key: LOCAL_STORAGE_KEYS.localSettings,
				storageArea: localStorage,
			}),
		);
		await waitFor(() =>
			expect(
				screen.getByRole<HTMLSelectElement>('combobox', { name: 'Code Editor Font Size' }).value,
			).toBe('20'),
		);
		expect(
			screen.getByRole<HTMLSelectElement>('combobox', { name: 'Code Diffs Font Size' }).value,
		).toBe('16');
		expect(
			screen.getByRole<HTMLSelectElement>('combobox', { name: 'Terminal Font Size' }).value,
		).toBe('15');
		expect(
			screen.getByRole<HTMLSelectElement>('combobox', { name: 'Interface Font Size' }).value,
		).toBe('default');
	});
});
