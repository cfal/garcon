<script lang="ts">
	import { onDestroy } from 'svelte';
	import {
		getSurfaceFrameBridge,
		setSurfaceFrameBridge,
		type SurfaceFrameBridge,
	} from '$lib/workspace/surface-frame-context.js';
	import { surfaceRendererTestProbe } from './surface-renderer-test-probe.js';
	import type { ChatDraftAppend } from '$lib/chat/composer/chat-draft-append.js';

	let {
		onClose,
		closeDisabled = false,
		onAppendToChatDraft,
		onChooseProjectFolder,
		frameBridge,
	}: {
		onClose?: () => void;
		closeDisabled?: boolean;
		onAppendToChatDraft?: ChatDraftAppend;
		onChooseProjectFolder?: () => void;
		frameBridge: SurfaceFrameBridge;
	} = $props();

	setSurfaceFrameBridge(() => frameBridge);
	const unregister = getSurfaceFrameBridge().provideRenderer({
		attach: () => surfaceRendererTestProbe.attach(),
		detach: () => surfaceRendererTestProbe.detach(),
		focusPrimary: () => undefined,
	});

	onDestroy(unregister);
</script>

<div data-testid="surface-renderer-stub">Surface renderer</div>
{#if onChooseProjectFolder}
	<button type="button" onclick={onChooseProjectFolder}>Choose chat folder</button>
{/if}
{#if onClose}
	<button type="button" onclick={onClose} disabled={closeDisabled}>Close file</button>
{/if}
{#if onAppendToChatDraft}
	<button type="button" onclick={() => onAppendToChatDraft('Git review comment')}>
		Append review comment
	</button>
{/if}
