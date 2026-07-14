<script lang="ts">
	import X from '@lucide/svelte/icons/x';
	import { Button } from '$lib/components/ui/button';
	import * as m from '$lib/paraglide/messages.js';

	let {
		message,
		onRetry,
		onClose,
		closeDisabled = false,
	}: {
		message: string;
		onRetry: () => void;
		onClose?: () => void;
		closeDisabled?: boolean;
	} = $props();
</script>

<div class="grid h-full place-items-center px-6 text-center">
	<div class="max-w-sm text-sm text-status-error-foreground">
		<p>{message}</p>
		<div class="mt-3 flex items-center justify-center gap-2">
			<Button variant="outline" size="sm" onclick={onRetry}>{m.common_retry()}</Button>
			{#if onClose}
				<Button variant="outline" size="sm" onclick={onClose} disabled={closeDisabled}>
					<X class="h-3.5 w-3.5" />
					{m.workspace_close_view()}
				</Button>
			{/if}
		</div>
	</div>
</div>
