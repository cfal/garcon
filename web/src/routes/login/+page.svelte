<script lang="ts">
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { getAuth } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';

	const auth = getAuth();

	let username = $state('');
	let password = $state('');
	let isSubmitting = $state(false);
	let error = $state('');

	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		error = '';

		if (!username || !password) {
			error = m.auth_login_errors_required_fields();
			return;
		}

		isSubmitting = true;
		const result = await auth.login(username, password);
		if (!result.success) {
			error = result.error || m.auth_login_errors_invalid_credentials();
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

	<div class="relative w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-lg">
		<h1 class="mb-5 text-center text-xl font-semibold text-foreground">{m.auth_login_title()}</h1>

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

				{#if error}
					<div class="rounded-md border border-status-error-border bg-status-error p-3">
						<p class="text-sm text-status-error-foreground">{error}</p>
					</div>
				{/if}

				<div class="pt-2">
					<Button type="submit" class="w-full" disabled={isSubmitting}>
						{isSubmitting ? m.auth_login_loading() : m.auth_login_submit()}
					</Button>
				</div>
		</form>
	</div>
</div>
