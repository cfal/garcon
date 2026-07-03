<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { getAuth } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import { LOCAL_STORAGE_KEYS, setLocalStorageItem } from '$lib/utils/local-persistence';
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import LogIn from '@lucide/svelte/icons/log-in';
	import UserPlus from '@lucide/svelte/icons/user-plus';

	const auth = getAuth();

	type AuthMode = 'login' | 'register';

	let mode = $state<AuthMode>('login');
	let username = $state('');
	let password = $state('');
	let confirmPassword = $state('');
	let isSubmitting = $state(false);
	let error = $state('');
	let showPassword = $state(false);
	let showConfirmPassword = $state(false);

	function getReturnTo(): string {
		const raw = page.url.searchParams.get('returnTo');
		if (raw && raw.startsWith('/') && !raw.startsWith('//')) return raw;
		return '/';
	}

	function validateRegisterInput(): string | null {
		if (password !== confirmPassword) return m.auth_setup_errors_password_mismatch();
		const trimmedUsername = username.trim();
		if (trimmedUsername.length < 1) return m.auth_setup_errors_username_required();
		if (trimmedUsername.length > 64) return m.auth_setup_errors_username_too_long();
		if (password.length < 8) return m.auth_setup_errors_password_too_short();
		if (password.length > 128) return m.auth_setup_errors_password_too_long();
		return null;
	}

	function setMode(nextMode: AuthMode): void {
		mode = nextMode;
		error = '';
	}

	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		if (!username || !password) {
			error = m.auth_login_errors_required_fields();
			return;
		}

		if (mode === 'register') {
			const validationError = validateRegisterInput();
			if (validationError) {
				error = validationError;
				return;
			}
		}

		try {
			isSubmitting = true;
			const result =
				mode === 'register'
					? await auth.register(username.trim(), password)
					: await auth.login(username, password);
			if (!result.success) {
				error =
					result.error ||
					(mode === 'register'
						? m.auth_setup_errors_registration_failed()
						: m.auth_login_errors_invalid_credentials());
			} else {
				if (mode === 'register') {
					setLocalStorageItem(LOCAL_STORAGE_KEYS.justRegistered, '1');
				}
				goto(getReturnTo());
			}
		} catch {
			error =
				mode === 'register'
					? m.auth_setup_errors_registration_failed()
					: m.auth_login_errors_invalid_credentials();
		} finally {
			isSubmitting = false;
		}
	}
</script>

<div class="relative flex min-h-dvh items-center justify-center bg-background px-4 py-8">
	<div
		class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,hsl(var(--primary)/0.08),transparent_42%)]"
	></div>

	<div class="relative w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-lg">
		<h1 class="mb-5 text-center text-xl font-semibold text-foreground">
			{mode === 'register' ? m.auth_register_title() : m.auth_login_title()}
		</h1>

		<div class="mb-5 grid grid-cols-2 rounded-md border border-border bg-muted p-1">
			<Button
				type="button"
				variant={mode === 'login' ? 'secondary' : 'ghost'}
				class="h-9 gap-2"
				onclick={() => setMode('login')}
				aria-pressed={mode === 'login'}
			>
				<LogIn class="size-4" />
				{m.auth_login_submit()}
			</Button>
			<Button
				type="button"
				variant={mode === 'register' ? 'secondary' : 'ghost'}
				class="h-9 gap-2"
				onclick={() => setMode('register')}
				aria-pressed={mode === 'register'}
			>
				<UserPlus class="size-4" />
				{m.auth_setup_create_account()}
			</Button>
		</div>

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

			{#if mode === 'register'}
				<div>
					<label for="confirmPassword" class="mb-1 block text-sm font-medium text-foreground">
						{m.auth_setup_confirm_password()}
					</label>
					<div class="relative">
						<Input
							type={showConfirmPassword ? 'text' : 'password'}
							id="confirmPassword"
							bind:value={confirmPassword}
							placeholder={m.auth_setup_confirm_password_placeholder()}
							required
							disabled={isSubmitting}
							class="pr-10"
						/>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							class="absolute right-0 top-0 h-full px-3 text-muted-foreground hover:text-foreground"
							onclick={() => (showConfirmPassword = !showConfirmPassword)}
							aria-label={showConfirmPassword ? m.auth_password_hide() : m.auth_password_show()}
						>
							{#if showConfirmPassword}
								<EyeOff class="size-4" />
							{:else}
								<Eye class="size-4" />
							{/if}
						</Button>
					</div>
				</div>
			{/if}

			<div>
				<label for="password" class="mb-1 block text-sm font-medium text-foreground">
					{m.auth_login_password()}
				</label>
				<div class="relative">
					<Input
						type={showPassword ? 'text' : 'password'}
						id="password"
						bind:value={password}
						placeholder={m.auth_login_placeholders_password()}
						required
						disabled={isSubmitting}
						class="pr-10"
					/>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						class="absolute right-0 top-0 h-full px-3 text-muted-foreground hover:text-foreground"
						onclick={() => (showPassword = !showPassword)}
						aria-label={showPassword ? m.auth_password_hide() : m.auth_password_show()}
					>
						{#if showPassword}
							<EyeOff class="size-4" />
						{:else}
							<Eye class="size-4" />
						{/if}
					</Button>
				</div>
			</div>

			{#if error}
				<div class="rounded-md border border-status-error-border bg-status-error p-3">
					<p class="text-sm text-status-error-foreground">{error}</p>
				</div>
			{/if}

			<div class="pt-2">
				<Button type="submit" class="w-full" disabled={isSubmitting}>
					{#if isSubmitting}
						{mode === 'register' ? m.auth_register_loading() : m.auth_login_loading()}
					{:else}
						{mode === 'register' ? m.auth_setup_create_account() : m.auth_login_submit()}
					{/if}
				</Button>
			</div>
		</form>
	</div>
</div>
