import { tick } from 'svelte';

function focusOrigin(root: HTMLElement, focused: HTMLElement) {
	let element: HTMLElement | null = focused;
	let control: string | undefined;
	while (element) {
		control ??= element.closest<HTMLElement>('[data-composer-control]')?.dataset.composerControl;
		if (root.contains(element)) {
			const group = element.closest<HTMLElement>('[data-composer-group]')?.dataset.composerGroup;
			return group ? { group, control } : null;
		}
		const labelledBy: string | null | undefined = element
			.closest('[role="menu"]')
			?.getAttribute('aria-labelledby');
		const trigger: HTMLElement | null = labelledBy ? document.getElementById(labelledBy) : null;
		if (!trigger || trigger === element) return null;
		element = trigger;
	}
	return null;
}

export async function retainComposerToolbarFocus(root: HTMLElement): Promise<void> {
	const previous = document.activeElement;
	if (!(previous instanceof HTMLElement)) return;
	const origin = focusOrigin(root, previous);
	if (!origin) return;
	await tick();
	if (!root.isConnected || (previous.isConnected && !previous.closest('[hidden]'))) return;
	const current = document.activeElement;
	if (current !== previous && current !== document.body && current?.isConnected) return;
	const group = root.querySelector<HTMLElement>(`[data-composer-group="${origin.group}"]`);
	if (!group) return;
	const control =
		origin.control &&
		group.querySelector<HTMLElement>(`[data-composer-control="${CSS.escape(origin.control)}"]`);
	const target =
		control &&
		!control.closest('[hidden]') &&
		(control.matches('button') ? control : control.querySelector('button'));
	(
		target ||
		group.querySelector<HTMLElement>(
			'[data-composer-overflow]:not(:disabled), button:not(:disabled):not([hidden] button)',
		)
	)?.focus({ preventScroll: true });
}
