import { describe, expect, it } from 'vitest';
import { fitComposerToolbar, type ComposerToolbarControls } from '../composer-toolbar-layout';

const chat = {
	prompt: ['snippet', 'image', 'refine', 'expand'],
	settings: ['executor', 'model', 'effort', 'agent:speed', 'permission'],
	send: true,
	bypass: false,
	refining: false,
} satisfies ComposerToolbarControls;
const labels = { model: 7, combined: 15 };

describe('composer toolbar fit', () => {
	it('promotes both groups and both labels without empty menus', () => {
		const fit = fitComposerToolbar(chat, 80, labels);
		expect(fit.inline).toEqual(new Set([...chat.prompt, ...chat.settings]));
		expect(fit).toMatchObject({
			promptMenu: false,
			settingsMenu: false,
			fullExecutor: true,
			modelDisplay: 'combined',
		});
	});

	it('compacts the executor, then folds it before sacrificing a readable model', () => {
		const medium = fitComposerToolbar(chat, 26, labels);
		expect(medium.inline.has('executor')).toBe(true);
		expect(medium.fullExecutor).toBe(false);
		const narrow = fitComposerToolbar(chat, 15, labels);
		expect([...narrow.inline]).toEqual(['model']);
		expect(narrow).toMatchObject({ promptMenu: true, settingsMenu: true, modelDisplay: 'model' });
		expect(fitComposerToolbar(chat, 12, labels).modelDisplay).toBe('overflow');
	});

	it('gives an unplaceable model its menu row, not the space of every other control', () => {
		const fit = fitComposerToolbar(chat, 30, { model: 45, combined: 50 });
		expect(fit.modelDisplay).toBe('overflow');
		expect(fit.inline).toEqual(
			new Set([...chat.prompt, ...chat.settings.filter((id) => id !== 'model')]),
		);
		expect(fit.settingsMenu).toBe(true);
	});

	it('never removes a short agent prefix to promote a shortcut as the tile grows', () => {
		const modes = new Set<string>();
		for (let pixels = 120; pixels <= 640; pixels++) {
			const { modelDisplay } = fitComposerToolbar(chat, pixels / 16, { model: 7, combined: 8 });
			if (modes.has('combined')) expect(modelDisplay).toBe('combined');
			modes.add(modelDisplay);
		}
		expect([...modes]).toEqual(['overflow', 'model', 'combined']);
	});

	it('preserves cancellation and a configurable bypass ahead of ordinary controls', () => {
		const fit = fitComposerToolbar({ ...chat, refining: true, bypass: true }, 15, labels);
		expect(fit.inline.has('refine')).toBe(true);
		expect(fit.inline.has('permission')).toBe(true);
		expect(fit.inline.has('agent:speed')).toBe(false);
	});

	it('only budgets applicable actions, including the no-send scheduling form', () => {
		const fit = fitComposerToolbar(
			{ ...chat, prompt: [], settings: ['model'], send: false },
			7,
			labels,
		);
		expect([...fit.inline]).toEqual(['model']);
		expect(fit).toMatchObject({ promptMenu: false, settingsMenu: false, fullExecutor: false });
	});

	it('uses exact label widths and the wider Send gap for both fit transitions', () => {
		const controls = { ...chat, prompt: [], settings: ['model'] } as const;
		const widths = { model: 7.125, combined: 10.5 };
		const fit = (w: number) => fitComposerToolbar(controls, w, widths).modelDisplay;
		expect([13.25, 13.249, 9.875, 9.874, 13.25].map(fit)).toEqual([
			'combined',
			'model',
			'model',
			'overflow',
			'combined',
		]);
		expect(fitComposerToolbar({ ...controls, send: false }, 7.125, widths).modelDisplay).toBe(
			'model',
		);
	});

	it('does not strand a single fixed-size command behind an equally wide menu trigger', () => {
		const fit = fitComposerToolbar({ ...chat, settings: ['permission'] }, 10);
		expect(fit.inline.has('permission')).toBe(true);
		expect(fit.settingsMenu).toBe(false);
		expect(fit.promptMenu).toBe(true);
	});
});
