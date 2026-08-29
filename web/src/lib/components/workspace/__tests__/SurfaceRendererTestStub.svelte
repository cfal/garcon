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
		frameBridge,
	}: {
		onClose?: () => void;
		closeDisabled?: boolean;
		onAppendToChatDraft?: ChatDraftAppend;
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
{#if onClose}
	<button type="button" onclick={onClose} disabled={closeDisabled}>Close file</button>
{/if}
{#if onAppendToChatDraft}
	<button type="button" onclick={() => onAppendToChatDraft('Git review comment')}>
		Append review comment
	</button>
{/if}
