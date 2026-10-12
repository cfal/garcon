<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { getAuth } from '$lib/context';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Dialog from '$lib/components/ui/dialog';
	import LogOut from '@lucide/svelte/icons/log-out';
	import PasswordInput from '$lib/components/auth/PasswordInput.svelte';
	import { validateUsername } from '$shared/auth';
	import * as m from '$lib/paraglide/messages.js';

	const auth = getAuth();
	let username = $state(untrack(() => auth.user?.username ?? ''));
	let usernamePassword = $state('');
	let passwordCurrent = $state('');
	let passwordNew = $state('');
	let passwordConfirmation = $state('');
	let usernameError = $state('');
	let passwordError = $state('');
	let success = $state('');
	let successForm = $state<'username' | 'password' | null>(null);
	let mounted = true;
	let confirmLogout = $state(false);
	const available = $derived(
		auth.isAuthenticated && !auth.credentialPending && !auth.logoutPending,
	);
	const canSubmitUsername = $derived(
		available &&
			username.trim() !== auth.user?.username &&
			!!username.trim() &&
			username.length <= 64 &&
			!!usernamePassword &&
			usernamePassword.length <= 128,
	);
	const canSubmitPassword = $derived(
		available &&
			!!passwordCurrent &&
			passwordCurrent.length <= 128 &&
			passwordNew.length >= 8 &&
			passwordNew.length <= 128 &&
			passwordNew === passwordConfirmation,
	);
	const passwordMismatch = $derived(!!passwordConfirmation && passwordNew !== passwordConfirmation);

	function clearPasswords() {
		usernamePassword = '';
		passwordCurrent = '';
		passwordNew = '';
		passwordConfirmation = '';
	}
	$effect(() => {
		if (!auth.isAuthenticated) clearPasswords();
	});
	onDestroy(() => {
		mounted = false;
		clearPasswords();
	});

	async function submitUsername(event: SubmitEvent) {
		event.preventDefault();
		if (!canSubmitUsername) return;
		usernameError = '';
		success = '';
		try {
			validateUsername(username);
		} catch (error) {
			usernameError = error instanceof Error ? error.message : '';
			return;
		}
		const result = await auth.changeUsername({ username, currentPassword: usernamePassword });
		if (!mounted) return;
		usernamePassword = '';
		if (result.success) {
			clearPasswords();
			username = auth.user?.username ?? username;
			success = m.auth_username_changed();
			successForm = 'username';
		} else usernameError = result.error ?? '';
	}
	async function submitPassword(event: SubmitEvent) {
		event.preventDefault();
		if (!canSubmitPassword) return;
		passwordError = '';
		success = '';
		const result = await auth.changePassword({
			currentPassword: passwordCurrent,
			newPassword: passwordNew,
		});
		if (!mounted) return;
		passwordCurrent = '';
		if (result.success) {
			clearPasswords();
			success = m.auth_password_changed();
			successForm = 'password';
		} else passwordError = result.error ?? '';
	}
</script>

<section class="max-w-lg space-y-6" aria-label={m.settings_tab_authentication()}>
	<h2 class="text-lg font-semibold">{m.settings_tab_authentication()}</h2>
	{#if auth.authDisabled}
		<p class="text-sm text-muted-foreground">{m.auth_disabled_notice()}</p>
	{:else}
		<Button variant="outline" disabled={!available} onclick={() => (confirmLogout = true)}>
			<LogOut class="size-4" />{m.auth_logout()}
		</Button>
		{#if confirmLogout}
			<Dialog.Root bind:open={confirmLogout}>
				<Dialog.Content>
					<Dialog.Header>
						<Dialog.Title>{m.auth_logout_title()}</Dialog.Title>
						<Dialog.Description>{m.auth_logout_description()}</Dialog.Description>
					</Dialog.Header>
					<Dialog.Footer>
						<Button variant="outline" onclick={() => (confirmLogout = false)}
							>{m.common_cancel()}</Button
						>
						<Button
							disabled={!available}
							onclick={() => {
								if (available) void auth.logout();
							}}
						>
							<LogOut class="size-4" />{m.auth_logout()}
						</Button>
					</Dialog.Footer>
				</Dialog.Content>
			</Dialog.Root>
		{/if}
		<p class="text-sm text-muted-foreground">{m.auth_other_devices_notice()}</p>
		<form onsubmit={submitUsername} class="space-y-3" aria-label={m.auth_change_username()}>
			<h3 class="font-medium">{m.auth_login_username()}</h3>
			<div class="space-y-1">
				<label for="account-username" class="text-sm">{m.auth_login_username()}</label>
				<Input
					id="account-username"
					bind:value={username}
					autocomplete="username"
					autocapitalize="none"
					spellcheck="false"
					maxlength={64}
					required
					disabled={!available}
				/>
			</div>
			<div class="space-y-1">
				<label for="username-current-password" class="text-sm">{m.auth_current_password()}</label>
				<PasswordInput
					id="username-current-password"
					bind:value={usernamePassword}
					autocomplete="current-password"
					maxlength={128}
					required
					disabled={!available}
					aria-describedby={usernameError ? 'username-error' : undefined}
					aria-invalid={!!usernameError}
				/>
			</div>
			{#if usernameError}<p id="username-error" role="alert" class="text-sm text-destructive">
					{usernameError}
				</p>{/if}
			<Button type="submit" disabled={!canSubmitUsername}>{m.auth_change_username()}</Button>
			{#if successForm === 'username'}<p role="status" aria-live="polite" class="text-sm">
					{success}
				</p>{/if}
		</form>
		<form
			onsubmit={submitPassword}
			class="space-y-3 border-t border-border pt-6"
			aria-label={m.auth_change_password()}
		>
			<h3 class="font-medium">{m.auth_login_password()}</h3>
			<div class="space-y-1">
				<label for="password-current-password" class="text-sm">{m.auth_current_password()}</label>
				<PasswordInput
					id="password-current-password"
					bind:value={passwordCurrent}
					autocomplete="current-password"
					maxlength={128}
					required
					disabled={!available}
					aria-describedby={passwordError ? 'password-error' : undefined}
					aria-invalid={!!passwordError}
				/>
			</div>
			<div class="space-y-1">
				<label for="account-new-password" class="text-sm">{m.auth_new_password()}</label>
				<PasswordInput
					id="account-new-password"
					bind:value={passwordNew}
					autocomplete="new-password"
					minlength={8}
					maxlength={128}
					required
					disabled={!available}
				/>
			</div>
			<div class="space-y-1">
				<label for="account-confirm-password" class="text-sm">{m.auth_confirm_password()}</label>
				<PasswordInput
					id="account-confirm-password"
					bind:value={passwordConfirmation}
					autocomplete="new-password"
					maxlength={128}
					required
					disabled={!available}
					aria-describedby={passwordMismatch ? 'password-mismatch' : undefined}
					aria-invalid={passwordMismatch}
				/>
			</div>
			{#if passwordMismatch}<p id="password-mismatch" class="text-sm text-destructive">
					{m.auth_password_mismatch()}
				</p>{/if}
			{#if passwordError}<p id="password-error" role="alert" class="text-sm text-destructive">
					{passwordError}
				</p>{/if}
			<Button type="submit" disabled={!canSubmitPassword}>{m.auth_change_password()}</Button>
			{#if successForm === 'password'}<p role="status" aria-live="polite" class="text-sm">
					{success}
				</p>{/if}
		</form>
		{#if auth.persistenceWarning}<p role="status" class="text-sm text-muted-foreground">
				{m.auth_persistence_warning()}
			</p>{/if}
	{/if}
</section>
