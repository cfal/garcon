import { tick } from 'svelte';

function focusOrigin(root: HTMLElement, focused: HTMLElement) {
	let element: HTMLElement | null = focused;
	let control: string | undefined;
	while (element) {
		control ??= element.closest<HTMLElement>('[data-composer-control]')?.dataset.composerControl;
		if (root.contains(element)) {
			const group = element.closest<HTMLElement>('[data-composer-group]')?.dataset.composerGroup;
			return group ? { group, control, overflow: element.dataset.composerOverflow } : null;
		}
		const menuId: string | undefined = element.closest('[role="menu"]')?.id;
		const trigger: HTMLElement | null = menuId
			? document.querySelector(`[aria-controls="${CSS.escape(menuId)}"]`)
			: null;
		if (!trigger || trigger === element) return null;
		element = trigger;
	}
	return null;
}

export async function retainComposerToolbarFocus(
	root: HTMLElement,
	inline: ReadonlySet<string>,
	closeOverflow: (group: string) => void,
): Promise<void> {
	const previous = document.activeElement;
	if (!(previous instanceof HTMLElement)) return;
	const origin = focusOrigin(root, previous);
	if (!origin) return;
	const promoted = origin.overflow && origin.control && inline.has(origin.control);
	if (promoted) closeOverflow(origin.group);
	await tick();
	const current = document.activeElement;
	if (
		!root.isConnected ||
		(current !== previous && current !== document.body && current?.isConnected)
	)
		return;
	if (!promoted && previous.isConnected && !previous.closest('[hidden]')) {
		if (current !== previous) previous.focus({ preventScroll: true });
		return;
	}
	const group = root.querySelector<HTMLElement>(`[data-composer-group="${origin.group}"]`);
	if (!group) return;
	const control =
		origin.control &&
		group.querySelector<HTMLElement>(`[data-composer-control="${CSS.escape(origin.control)}"]`);
	const target =
		control &&
		!control.closest('[hidden]') &&
		(control.matches('button:enabled') ? control : control.querySelector('button:enabled'));
	(
		target ||
		group.querySelector<HTMLElement>('[data-composer-overflow]:not(:disabled)') ||
		group.querySelector<HTMLElement>('button:not(:disabled):not([hidden] button)')
	)?.focus({ preventScroll: true });
}
