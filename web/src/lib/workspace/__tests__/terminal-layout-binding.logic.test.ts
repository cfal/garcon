import { describe, expect, it, vi } from 'vitest';
import { TerminalLayoutBinding } from '../terminal-layout-binding.js';

function createHarness(
	overrides: {
		restoreSource?: 'absent' | 'valid' | 'fallback';
		dismissed?: boolean;
	} = {},
) {
	const reconcileTerminals = vi.fn(async () => undefined);
	const onError = vi.fn();
	const binding = new TerminalLayoutBinding({
		restoreSource: overrides.restoreSource ?? 'absent',
		workspace: { reconcileTerminals },
		isLauncherDismissed: () => overrides.dismissed ?? false,
		onError,
	});
	return { binding, reconcileTerminals, onError };
}

describe('TerminalLayoutBinding', () => {
	it('derives the launcher only from the first successful empty List', async () => {
		const { binding, reconcileTerminals } = createHarness();

		binding.handleSuccessfulList([]);
		await vi.waitFor(() => expect(reconcileTerminals).toHaveBeenCalledTimes(1));
		expect(reconcileTerminals).toHaveBeenNthCalledWith(1, [], { deriveLauncher: true });

		binding.handleSuccessfulList([]);
		await vi.waitFor(() => expect(reconcileTerminals).toHaveBeenCalledTimes(2));
		expect(reconcileTerminals).toHaveBeenNthCalledWith(2, [], { deriveLauncher: false });
		binding.destroy();
	});

	it('consumes first-run derivation when the first successful List is nonempty', async () => {
		const { binding, reconcileTerminals } = createHarness();

		binding.handleSuccessfulList(['one']);
		binding.handleSuccessfulList([]);

		await vi.waitFor(() => expect(reconcileTerminals).toHaveBeenCalledTimes(2));
		expect(reconcileTerminals.mock.calls).toEqual([
			[['one'], { deriveLauncher: false }],
			[[], { deriveLauncher: false }],
		]);
		binding.destroy();
	});

	it.each([
		{ restoreSource: 'valid' as const, dismissed: false },
		{ restoreSource: 'absent' as const, dismissed: true },
	])(
		'does not derive for $restoreSource restoration when dismissed=$dismissed',
		async (options) => {
			const { binding, reconcileTerminals } = createHarness(options);

			binding.handleSuccessfulList([]);

			await vi.waitFor(() => expect(reconcileTerminals).toHaveBeenCalledOnce());
			expect(reconcileTerminals).toHaveBeenCalledWith([], { deriveLauncher: false });
			binding.destroy();
		},
	);

	it('serializes successful List reconciliation and reports failures without stopping the queue', async () => {
		let rejectFirst!: (reason: unknown) => void;
		const first = new Promise<void>((_resolve, reject) => {
			rejectFirst = reject;
		});
		const reconcileTerminals = vi
			.fn<(_ids: readonly string[], _options: { deriveLauncher: boolean }) => Promise<void>>()
			.mockReturnValueOnce(first)
			.mockResolvedValue(undefined);
		const onError = vi.fn();
		const binding = new TerminalLayoutBinding({
			restoreSource: 'absent',
			workspace: { reconcileTerminals },
			isLauncherDismissed: () => false,
			onError,
		});

		binding.handleSuccessfulList(['one']);
		binding.handleSuccessfulList(['two']);
		await vi.waitFor(() => expect(reconcileTerminals).toHaveBeenCalledOnce());
		rejectFirst(new Error('reconciliation failed'));

		await vi.waitFor(() => expect(reconcileTerminals).toHaveBeenCalledTimes(2));
		expect(onError).toHaveBeenCalledOnce();
		expect(reconcileTerminals).toHaveBeenNthCalledWith(2, ['two'], { deriveLauncher: false });
		binding.destroy();
	});
});
