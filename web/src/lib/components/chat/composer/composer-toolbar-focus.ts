import { tick } from 'svelte';
import type { ComposerToolbarLayout } from '$lib/chat/composer/composer-toolbar-layout';

const visibleButton = 'button:not(:disabled):not([hidden]):not([hidden] *)';

function focusOrigin(root: HTMLElement, focused: HTMLElement) {
	let element: HTMLElement | null = focused;
	let control: string | undefined;
	while (element) {
		control ??= element.closest<HTMLElement>('[data-composer-control]')?.dataset.composerControl;
		if (root.contains(element)) {
			const group = element.closest<HTMLElement>('[data-composer-group]')?.dataset.composerGroup;
			if (!group) return null;
			return {
				group,
				control,
				overflow: element.hasAttribute('data-composer-overflow') ? element : null,
			};
		}
		const menuId: string | undefined = element.closest('[role="menu"]')?.id;
		if (!menuId) return null;
		const trigger: HTMLElement | null = document.querySelector(
			`[aria-controls="${CSS.escape(menuId)}"]`,
		);
		if (!trigger || trigger === element) return null;
		element = trigger;
	}
	return null;
}

export async function retainComposerToolbarFocus(
	root: HTMLElement,
	layout: ComposerToolbarLayout,
	closeOverflow: (group: string, afterClose: () => void) => void,
): Promise<void> {
	const previous = document.activeElement;
	if (!(previous instanceof HTMLElement)) return;
	const origin = focusOrigin(root, previous);
	if (!origin) return;
	const focusReplacement = () => {
		const group = root.querySelector<HTMLElement>(`[data-composer-group="${origin.group}"]`);
		if (!root.isConnected || !group) return;
		const control = origin.control
			? group.querySelector<HTMLButtonElement>(
					`${visibleButton}[data-composer-control="${CSS.escape(origin.control)}"]`,
				)
			: null;
		(
			control ??
			group.querySelector<HTMLButtonElement>(`${visibleButton}[data-composer-overflow]`) ??
			group.querySelector<HTMLButtonElement>(visibleButton)
		)?.focus({ preventScroll: true });
	};
	const inline: ReadonlySet<string> = layout.inline;
	const folded: readonly string[] = origin.group === 'prompt' ? layout.foldedPrompt : layout.foldedSettings;
	if (
		origin.overflow?.getAttribute('aria-expanded') === 'true' &&
		(!folded.length || (origin.control && !folded.includes(origin.control)))
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
	if (folding || !previous.isConnected || previous.closest('[hidden]')) {
		focusReplacement();
	} else if (current !== previous) {
		previous.focus({ preventScroll: true });
	}
}
