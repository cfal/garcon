import { tick } from 'svelte';
import type { fitComposerToolbar } from '$lib/chat/composer/composer-toolbar-layout';

function focusOrigin(root: HTMLElement, focused: HTMLElement) {
	let element: HTMLElement | null = focused;
	let control: string | undefined;
	while (element) {
		control ??= element.closest<HTMLElement>('[data-composer-control]')?.dataset.composerControl;
		if (root.contains(element)) {
			const group = element.closest<HTMLElement>('[data-composer-group]')?.dataset.composerGroup;
			return group
				? {
						group,
						control,
						overflow: element.hasAttribute('data-composer-overflow') ? element : null,
					}
				: null;
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

export function handOffComposerMenuFocus(event: Event, afterClose?: () => void): void {
	if (!afterClose) return;
	event.preventDefault();
	// The parent focus scope resumes after the close-autofocus handler returns.
	queueMicrotask(afterClose);
}

export async function retainComposerToolbarFocus(
	root: HTMLElement,
	layout: Pick<ReturnType<typeof fitComposerToolbar>, 'inline' | 'promptMenu' | 'settingsMenu'>,
	closeOverflow: (group: string, afterClose: () => void) => void,
): Promise<void> {
	const previous = document.activeElement;
	if (!(previous instanceof HTMLElement)) return;
	const origin = focusOrigin(root, previous);
	if (!origin) return;
	const focusReplacement = () => {
		const group = root.querySelector<HTMLElement>(`[data-composer-group="${origin.group}"]`);
		if (!root.isConnected || !group) return;
		const control =
			origin.control &&
			group.querySelector<HTMLElement>(`[data-composer-control="${CSS.escape(origin.control)}"]`);
		const button =
			control &&
			!control.closest('[hidden]') &&
			(control.matches('button:not(:disabled)')
				? control
				: control.querySelector<HTMLButtonElement>('button:not(:disabled)'));
		(
			button ||
			group.querySelector<HTMLElement>('[data-composer-overflow]:not(:disabled)') ||
			group.querySelector<HTMLElement>('button:not(:disabled):not([hidden]):not([hidden] *)')
		)?.focus({ preventScroll: true });
	};
	const inline: ReadonlySet<string> = layout.inline;
	const overflowDisappears = origin.group === 'prompt' ? !layout.promptMenu : !layout.settingsMenu;
	if (
		origin.overflow?.getAttribute('aria-expanded') === 'true' &&
		(overflowDisappears || (origin.control && inline.has(origin.control)))
	) {
		closeOverflow(origin.group, focusReplacement);
		return;
	}
	const folding = !origin.overflow && origin.control && !inline.has(origin.control);
	await tick();
	const current = document.activeElement;
	if (
		!root.isConnected ||
		(current !== previous && current !== document.body && current?.isConnected)
	)
		return;
	if (!folding && previous.isConnected && !previous.closest('[hidden]')) {
		if (current !== previous) previous.focus({ preventScroll: true });
		return;
	}
	focusReplacement();
}
