<script lang="ts">
	import type { Edge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
	import { getLocalSettings } from '$lib/context';
	import {
		moveDesktopLayoutPane,
		type DesktopLayoutOrder,
		type DesktopLayoutPane,
	} from '$lib/layout/desktop-layout.js';
	import * as m from '$lib/paraglide/messages.js';
	import { reorderDesktopLayoutPaneFromDrop } from './desktop-layout-drop.js';
	import DesktopLayoutOrderRow from './DesktopLayoutOrderRow.svelte';

	const localSettings = getLocalSettings();
	let announcement = $state('');
	const paneLabels: Record<DesktopLayoutPane, () => string> = {
		'chat-list': m.settings_desktop_layout_chat_list,
		main: m.settings_desktop_layout_main_view,
		'workspace-sidebar': m.settings_desktop_layout_workspace_sidebar,
	};

	function commitOrder(pane: DesktopLayoutPane, next: DesktopLayoutOrder): void {
		if (next.every((candidate, index) => candidate === localSettings.desktopLayoutOrder[index])) {
			return;
		}
		localSettings.set('desktopLayoutOrder', next);
		announcement = m.settings_desktop_layout_reordered({
			pane: paneLabels[pane](),
			position: next.indexOf(pane) + 1,
		});
	}

	function commitMove(pane: DesktopLayoutPane, destination: number): void {
		const from = localSettings.desktopLayoutOrder.indexOf(pane);
		if (from < 0 || from === destination) return;
		commitOrder(pane, moveDesktopLayoutPane(localSettings.desktopLayoutOrder, from, destination));
	}

	function move(pane: DesktopLayoutPane, delta: -1 | 1): void {
		commitMove(pane, localSettings.desktopLayoutOrder.indexOf(pane) + delta);
	}

	function drop(source: DesktopLayoutPane, target: DesktopLayoutPane, edge: Edge): void {
		commitOrder(
			source,
			reorderDesktopLayoutPaneFromDrop(localSettings.desktopLayoutOrder, source, target, edge),
		);
	}
</script>

<section class="border-t border-border pb-1 pt-2" aria-labelledby="desktop-layout-heading">
	<h3 id="desktop-layout-heading" class="py-2 text-sm font-medium text-foreground">
		{m.settings_desktop_layout()}
	</h3>
	<ol class="divide-y divide-border border-y border-border">
		{#each localSettings.desktopLayoutOrder as pane, index (pane)}
			<DesktopLayoutOrderRow
				{pane}
				label={paneLabels[pane]()}
				{index}
				count={localSettings.desktopLayoutOrder.length}
				onMove={move}
				onDrop={drop}
			/>
		{/each}
	</ol>
	<p class="sr-only" aria-live="polite">{announcement}</p>
</section>
