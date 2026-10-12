<script lang="ts">
	import { onMount } from 'svelte';
	import { getAuth } from '$lib/context';
	import SignInForm from './SignInForm.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as m from '$lib/paraglide/messages.js';
	const auth = getAuth();
	let dialog: HTMLDialogElement;
	onMount(() => {
		const focused = document.activeElement;
		// Native modal inertness includes existing portaled dialogs without unmounting them.
		dialog.showModal();
		return () => {
			dialog.close();
			if (focused instanceof HTMLElement && focused.isConnected) focused.focus();
		};
	});
</script>

<dialog
	bind:this={dialog}
	oncancel={(event) => event.preventDefault()}
	onpointerdown={(event) => event.stopPropagation()}
	onclick={(event) => event.stopPropagation()}
	aria-labelledby="reauth-title"
	class="transient-backdrop pointer-events-auto m-auto w-[calc(100%-2rem)] max-w-md rounded-lg border border-border bg-background p-6 text-foreground shadow-lg"
>
	<h1 id="reauth-title" class="mb-3 text-lg font-semibold">
		{auth.availability === 'reauth-required'
			? m.auth_reauthenticate_title()
			: m.auth_reconnecting_title()}
	</h1>
	{#if auth.availability === 'storage-unavailable'}
		<p role="alert" class="text-sm">{m.auth_storage_unavailable()}</p>
	{:else if auth.availability === 'reauth-required'}
		<p class="mb-4 text-sm text-muted-foreground">
			{auth.error ?? m.auth_reauthenticate_description()}
		</p>
		<SignInForm initialUsername={auth.user?.username ?? ''} />
	{:else}
		<p role="status" class="mb-4 text-sm text-muted-foreground">
			{m.auth_reconnecting_session_description()}
		</p>
		<Button onclick={() => auth.reconcile()}>{m.common_retry()}</Button>
	{/if}
</dialog>
