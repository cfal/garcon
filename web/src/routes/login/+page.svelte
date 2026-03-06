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

	<div class="relative w-full max-w-lg overflow-hidden rounded-lg border border-border bg-background shadow-lg">
		<div class="border-b border-border px-6 py-4">
			<div class="inline-flex items-center gap-2 rounded-md border border-border bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
				<Shield class="size-3.5" />
				Authentication
			</div>
			<h1 class="mt-3 text-xl font-semibold text-foreground">{m.auth_login_title()}</h1>
			<p class="mt-1 text-sm text-muted-foreground">
				This server is configured for single-user password protection.
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

				{#if error}
					<div class="rounded-md border border-status-error-border bg-status-error p-3">
						<p class="text-sm text-status-error-foreground">{error}</p>
					</div>
				{/if}

				<Button type="submit" class="w-full" disabled={isSubmitting}>
					{isSubmitting ? m.auth_login_loading() : m.auth_login_submit()}
				</Button>
			</form>
		</div>
	</div>
</div>
