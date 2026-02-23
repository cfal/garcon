<script lang="ts">
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { getAuth } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import MessageSquare from '@lucide/svelte/icons/message-square';

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

<div class="min-h-dvh bg-background flex items-center justify-center p-4">
	<div class="w-full max-w-md">
		<div class="bg-card rounded-lg shadow-lg border border-border p-8 space-y-6">
			<div class="text-center">
				<div class="flex justify-center mb-4">
					<div
						class="w-16 h-16 bg-primary rounded-lg flex items-center justify-center shadow-sm"
					>
						<MessageSquare class="w-8 h-8 text-primary-foreground" />
					</div>
				</div>
				<h1 class="text-2xl font-bold text-foreground">{m.auth_setup_title()}</h1>
				<p class="text-muted-foreground mt-2">{m.auth_setup_description()}</p>
			</div>

			<form onsubmit={handleSubmit} class="space-y-4">
				<div>
					<label for="username" class="block text-sm font-medium text-foreground mb-1">
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
					<label for="password" class="block text-sm font-medium text-foreground mb-1">
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
					<label
						for="confirmPassword"
						class="block text-sm font-medium text-foreground mb-1"
					>
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
					<div
						class="p-3 bg-status-error border border-status-error-border rounded-md"
					>
						<p class="text-sm text-status-error-foreground">{error}</p>
					</div>
				{/if}

				<Button type="submit" class="w-full" disabled={isSubmitting}>
					{isSubmitting ? m.auth_setup_setting_up() : m.auth_setup_create_account()}
				</Button>
			</form>

			<div class="text-center">
				<p class="text-sm text-muted-foreground">
					{m.auth_setup_single_user()}
				</p>
			</div>
		</div>
	</div>
</div>
