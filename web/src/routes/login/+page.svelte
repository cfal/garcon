<script lang="ts">
	import { goto } from '$app/navigation';
	import { appPath } from '$lib/deployment/paths';
	import { page } from '$app/state';
	import SignInForm from '$lib/components/auth/SignInForm.svelte';
	import * as m from '$lib/paraglide/messages.js';
	import { safeLoginReturnTo } from './login-return-to';
</script>

<div class="flex min-h-dvh items-center justify-center bg-background px-4 py-8">
	<div class="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-lg">
		<h1 class="mb-5 text-center text-xl font-semibold text-foreground">{m.auth_login_title()}</h1>
		{#if page.url.searchParams.get('loggedOut') === 'unconfirmed'}
			<p role="alert" class="mb-4 text-sm text-destructive">{m.auth_logout_unconfirmed()}</p>
		{:else if page.url.searchParams.get('loggedOut') === 'confirmed'}
			<p role="status" class="mb-4 text-sm text-muted-foreground">{m.auth_logout_confirmed()}</p>
		{:else if page.url.searchParams.get('loggedOut') === 'peer'}
			<p role="status" class="mb-4 text-sm text-muted-foreground">{m.auth_logout_peer()}</p>
		{/if}
		{#if page.url.searchParams.get('cleanup') === 'incomplete'}
			<p role="alert" class="mb-4 text-sm text-destructive">{m.auth_logout_cleanup_incomplete()}</p>
		{/if}
		<SignInForm
			onSuccess={() => goto(appPath(safeLoginReturnTo(page.url.searchParams.get('returnTo'))))}
		/>
	</div>
</div>
