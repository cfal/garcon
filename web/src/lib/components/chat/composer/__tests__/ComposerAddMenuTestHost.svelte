<script lang="ts">
	import ComposerAddMenu from '../ComposerAddMenu.svelte';
	import { untrack } from 'svelte';
	import { setAppShell } from '$lib/context';
	import { AppShellStore } from '$lib/stores/app-shell.svelte.js';

	interface Props {
		mobile?: boolean;
		canAttachImages?: boolean;
	}

	let { mobile = false, canAttachImages = false }: Props = $props();
	let paletteOpenCount = $state(0);
	let imagePickerOpenCount = $state(0);

	const appShell = new AppShellStore();
	appShell.isMobile = untrack(() => mobile);
	setAppShell(appShell);
</script>

<ComposerAddMenu
	disabled={false}
	{canAttachImages}
	attachImagesTooltip="Images are unavailable"
	onAddImage={() => (imagePickerOpenCount += 1)}
	onOpenSnippetPalette={() => (paletteOpenCount += 1)}
/>

<output data-testid="palette-open-count">{paletteOpenCount}</output>
<output data-testid="image-picker-open-count">{imagePickerOpenCount}</output>
