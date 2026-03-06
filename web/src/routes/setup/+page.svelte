<script lang="ts">
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { getAuth } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import Shield from '@lucide/svelte/icons/shield';

	const auth = getAuth();

	let username = $state('');
	let password = $state('');
	let confirmPassword = $state('');
	let isSubmitting = $state(false);
	let error = $state('');

	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		error = '';

		if (password !== confirmPassword) {
			error = m.auth_setup_errors_password_mismatch();
			return;
		}

		if (username.length < 3) {
			error = m.auth_setup_errors_username_too_short();
			return;
		}

		if (password.length < 6) {
			error = m.auth_setup_errors_password_too_short();
			return;
		}

		isSubmitting = true;
		const result = await auth.register(username, password);
		if (!result.success) {
			error = result.error || m.auth_setup_errors_registration_failed();
		} else {
			goto('/');
		}
		isSubmitting = false;
	}
</script>

<div class="relative flex min-h-dvh items-center justify-center bg-background px-4 py-8">
	<div
		class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,hsl(var(--primary)/0.08),transparent_42%)]"
	></div>

	<div class="relative w-full max-w-lg overflow-hidden rounded-lg border border-border bg-background shadow-lg">
		<div class="border-b border-border px-6 py-4">
			<div class="inline-flex items-center gap-2 rounded-md border border-border bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
				<Shield class="size-3.5" />
				{m.auth_setup_badge()}
			</div>
			<h1 class="mt-3 text-xl font-semibold text-foreground">{m.auth_setup_title()}</h1>
			<p class="mt-1 text-sm text-muted-foreground">
				{m.auth_setup_internet_exposure_notice()}
			</p>
			<p class="mt-2 text-sm text-muted-foreground">
				{m.auth_setup_disable_auth_hint()}
			</p>
		</div>

		<div class="px-6 py-5">
			<form onsubmit={handleSubmit} class="space-y-4">
				<div>
					<label for="username" class="mb-1 block text-sm font-medium text-foreground">
						{m.auth_login_username()}
					</label>
					<Input
						type="text"
						id="username"
						bind:value={username}
						placeholder={m.auth_login_placeholders_username()}
						required
						disabled={isSubmitting}
					/>
				</div>

				<div>
					<label for="password" class="mb-1 block text-sm font-medium text-foreground">
						{m.auth_login_password()}
					</label>
					<Input
						type="password"
						id="password"
						bind:value={password}
						placeholder={m.auth_login_placeholders_password()}
						required
						disabled={isSubmitting}
					/>
				</div>

				<div>
					<label for="confirmPassword" class="mb-1 block text-sm font-medium text-foreground">
						{m.auth_setup_confirm_password()}
					</label>
					<Input
						type="password"
						id="confirmPassword"
						bind:value={confirmPassword}
						placeholder={m.auth_setup_confirm_password_placeholder()}
						required
						disabled={isSubmitting}
					/>
				</div>

				{#if error}
					<div class="rounded-md border border-status-error-border bg-status-error p-3">
						<p class="text-sm text-status-error-foreground">{error}</p>
					</div>
				{/if}

					<div class="pt-2">
						<Button type="submit" class="w-full" disabled={isSubmitting}>
							{isSubmitting ? m.auth_setup_setting_up() : m.auth_setup_create_account()}
						</Button>
					</div>
				</form>
			</div>
		</div>
</div>
