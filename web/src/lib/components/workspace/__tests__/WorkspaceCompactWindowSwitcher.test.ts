import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import type { ComponentProps } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WorkspaceCompactWindowSwitcher from '../WorkspaceCompactWindowSwitcher.svelte';
import type { WorkspaceWindowId, WorkspaceWindowNode } from '$lib/workspace/surface-types.js';
import * as m from '$lib/paraglide/messages.js';

const windows = [
	workspaceWindow('window-main', 'surface-main'),
	workspaceWindow('window-2', 'surface-2'),
	workspaceWindow('window-3', 'surface-3'),
];
const titles: Record<string, string> = {
	'surface-main': 'First window',
	'surface-2': 'Second window',
	'surface-3': 'Third window',
};

function workspaceWindow(id: WorkspaceWindowId, activeId: string): WorkspaceWindowNode {
	return {
		type: 'window',
		id,
		tabs: { order: [activeId], activeId, mru: [activeId] },
	};
}

function renderSwitcher(
	overrides: Partial<ComponentProps<typeof WorkspaceCompactWindowSwitcher>> = {},
) {
	const onActivate = vi.fn();
	const onExitNavigation = vi.fn();
	const onEnableChatListAutohide = vi.fn();
	const props = {
		windows,
		currentWindowId: 'window-2' as WorkspaceWindowId,
		labelFor: (surfaceId: string) => titles[surfaceId] ?? surfaceId,
		chatListConsumesWorkspaceWidth: true,
		canEnableChatListAutohide: true,
		onActivate,
		onExitNavigation,
		onEnableChatListAutohide,
		...overrides,
	};
	return {
		...render(WorkspaceCompactWindowSwitcher, props),
		props,
		onActivate,
		onExitNavigation,
		onEnableChatListAutohide,
	};
}

afterEach(cleanup);

describe('WorkspaceCompactWindowSwitcher', () => {
	it('renders fixed-height accessible navigation and wraps previous and next', async () => {
		const { container, onActivate, rerender, props } = renderSwitcher();
		const navigation = screen.getByRole('navigation', {
			name: m.workspace_compact_window_list(),
		});

		expect(navigation.style.height).toBe('36px');
		expect(navigation.classList.contains('workspace-compact-switcher')).toBe(true);
		expect(container.textContent).toContain('Second window');

		await fireEvent.click(
			screen.getByRole('button', { name: m.workspace_compact_previous_window() }),
		);
		expect(onActivate).toHaveBeenLastCalledWith('window-main');

		await fireEvent.click(screen.getByRole('button', { name: m.workspace_compact_next_window() }));
		expect(onActivate).toHaveBeenLastCalledWith('window-3');

		await rerender({ ...props, currentWindowId: 'window-3' });
		await fireEvent.click(screen.getByRole('button', { name: m.workspace_compact_next_window() }));
		expect(onActivate).toHaveBeenLastCalledWith('window-main');
	});

	it('lists every window in depth-first order and marks the current item', async () => {
		const { onActivate } = renderSwitcher();
		const position = m.workspace_compact_window_position({ current: 2, count: 3 });
		const trigger = screen.getByRole('button', { name: position });
		expect(trigger.getAttribute('aria-haspopup')).toBe('menu');

		await fireEvent.click(trigger);
		const menu = document.querySelector<HTMLElement>('[data-workspace-compact-window-list]')!;
		const items = Array.from(
			menu.querySelectorAll<HTMLElement>('[data-workspace-compact-window-id]'),
		);
		expect(items.map((item) => item.dataset.workspaceCompactWindowId)).toEqual([
			'window-main',
			'window-2',
			'window-3',
		]);
		expect(items[1]?.getAttribute('aria-current')).toBe('true');
		expect(within(menu).getByText(m.workspace_compact_recovery_hint_resize())).toBeTruthy();

		await fireEvent.click(items[2]!);
		expect(onActivate).toHaveBeenCalledWith('window-3');
	});

	it('keeps the same focused control when the current window changes', async () => {
		const { props, rerender, onExitNavigation } = renderSwitcher();
		const nextButton = screen.getByRole('button', { name: m.workspace_compact_next_window() });
		nextButton.focus();
		await fireEvent.click(nextButton);
		await rerender({ ...props, currentWindowId: 'window-3' });
		expect(screen.getByRole('button', { name: m.workspace_compact_next_window() })).toBe(
			nextButton,
		);
		expect(document.activeElement).toBe(nextButton);
		expect(onExitNavigation).not.toHaveBeenCalled();
	});

	it('hands focus back on removal only when navigation owns focus', async () => {
		const { unmount, onExitNavigation } = renderSwitcher();
		screen.getByRole('button', { name: m.workspace_compact_next_window() }).focus();
		await unmount();
		expect(onExitNavigation).toHaveBeenCalledOnce();
	});

	it('does not move unrelated focus when removed', () => {
		const { unmount, onExitNavigation } = renderSwitcher();
		unmount();
		expect(onExitNavigation).not.toHaveBeenCalled();
	});

	it('offers auto-hide in the menu without extra recovery controls in the row', async () => {
		const { onEnableChatListAutohide } = renderSwitcher();
		expect(screen.getAllByRole('button')).toHaveLength(3);
		await fireEvent.click(
			screen.getByRole('button', {
				name: m.workspace_compact_window_position({ current: 2, count: 3 }),
			}),
		);
		await fireEvent.click(
			screen.getByRole('menuitem', { name: m.workspace_compact_enable_autohide() }),
		);
		expect(onEnableChatListAutohide).toHaveBeenCalledOnce();
	});

	it.each([{ canEnableChatListAutohide: false }, { chatListConsumesWorkspaceWidth: false }])(
		'omits unavailable auto-hide actions: %s',
		async (props) => {
			renderSwitcher(props);
			await fireEvent.click(
				screen.getByRole('button', {
					name: m.workspace_compact_window_position({ current: 2, count: 3 }),
				}),
			);
			expect(
				screen.queryByRole('menuitem', { name: m.workspace_compact_enable_autohide() }),
			).toBeNull();
		},
	);
});
