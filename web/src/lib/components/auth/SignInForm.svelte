<script lang="ts">
	import { untrack } from 'svelte';
	import { getAuth } from '$lib/context';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import * as m from '$lib/paraglide/messages.js';
	let {
		initialUsername = '',
		onSuccess = () => {},
	}: {
		initialUsername?: string;
		onSuccess?: () => void | Promise<void>;
	} = $props();
	const auth = getAuth();
	const id = $props.id();
	let username = $state(untrack(() => initialUsername));
	let password = $state('');
	let pending = $state(false);
	let error = $state('');
	let reveal = $state(false);
	const canSubmit = $derived(!!username && !!password && !pending);
	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!canSubmit) return;
		pending = true;
		error = '';
		const result = await auth.login(username, password);
		password = '';
		if (!result.success) error = result.error ?? m.auth_login_errors_invalid_credentials();
		else {
			try {
				await onSuccess();
			} catch {
				error = m.auth_login_errors_navigation_failed();
			}
		}
		pending = false;
	}
</script>

<form onsubmit={submit} class="space-y-4">
	<div class="space-y-1">
		<label for={`${id}-username`} class="text-sm font-medium">{m.auth_login_username()}</label>
		<Input
			id={`${id}-username`}
			name="username"
			bind:value={username}
			autocomplete="username"
			autocapitalize="none"
			spellcheck="false"
			required
			disabled={pending}
		/>
	</div>
	<div class="space-y-1">
		<label for={`${id}-password`} class="text-sm font-medium">{m.auth_login_password()}</label>
		<div class="relative">
			<Input
				id={`${id}-password`}
				name="password"
				type={reveal ? 'text' : 'password'}
				bind:value={password}
				autocomplete="current-password"
				required
				disabled={pending}
				class="pr-10"
			/>
			<Button
				type="button"
				variant="ghost"
				size="icon"
				class="absolute right-0 top-0 h-full"
				onclick={() => (reveal = !reveal)}
				aria-label={reveal ? m.auth_password_hide() : m.auth_password_show()}
				title={reveal ? m.auth_password_hide() : m.auth_password_show()}
			>
				{#if reveal}<EyeOff class="size-4" />{:else}<Eye class="size-4" />{/if}
			</Button>
		</div>
	</div>
	{#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
	<Button type="submit" class="w-full" disabled={!canSubmit}
		>{pending ? m.auth_login_loading() : m.auth_login_submit()}</Button
	>
</form>
