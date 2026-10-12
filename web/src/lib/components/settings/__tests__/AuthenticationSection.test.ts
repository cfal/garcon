import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { AuthStore } from '$lib/stores/auth.svelte';
import AuthenticationSection from '../AuthenticationSection.svelte';

let auth: AuthStore;
vi.mock('$lib/context', () => ({ getAuth: () => auth, getOptionalTransientLayers: () => null }));
beforeEach(() => {
	auth = new AuthStore();
	auth.user = { id: 'original', username: 'owner' };
	auth.token = 'synthetic';
	auth.availability = 'active';
});
afterEach(() => {
	cleanup();
	auth.destroy();
	vi.restoreAllMocks();
});

it('keeps disabled authentication discoverable without forms', () => {
	auth.authDisabled = true;
	render(AuthenticationSection);
	expect(screen.getByText('Authentication is disabled by server configuration.')).toBeTruthy();
	expect(screen.queryByRole('button')).toBeNull();
});

it('requires confirmation, supports cancel, and logs out only on confirmation', async () => {
	const logout = vi.spyOn(auth, 'logout').mockResolvedValue();
	render(AuthenticationSection);
	expect(screen.getByRole('heading', { name: 'Authentication' })).toBeTruthy();
	await fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
	const dialog = await screen.findByRole('dialog', { name: 'Log out of this browser?' });
	expect(logout).not.toHaveBeenCalled();
	await fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
	expect(logout).not.toHaveBeenCalled();
	await fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
	await fireEvent.click(
		within(await screen.findByRole('dialog', { name: 'Log out of this browser?' })).getByRole(
			'button',
			{ name: 'Log out' },
		),
	);
	expect(logout).toHaveBeenCalledTimes(1);
});

it('submits username by form, preserves Settings, and clears all secrets on success', async () => {
	const change = vi.spyOn(auth, 'changeUsername').mockImplementation(async () => {
		auth.user = { id: 'original', username: 'next' };
		return { success: true };
	});
	render(AuthenticationSection);
	await fireEvent.input(screen.getByLabelText('Username'), { target: { value: 'next' } });
	const form = screen.getByRole('form', { name: 'Change username' });
	await fireEvent.input(within(form).getByLabelText('Current password'), {
		target: { value: ' exact password ' },
	});
	await fireEvent.input(screen.getByLabelText('New password'), {
		target: { value: 'new-password' },
	});
	await fireEvent.submit(form);
	expect(change).toHaveBeenCalledExactlyOnceWith({
		username: 'next',
		currentPassword: ' exact password ',
	});
	expect(screen.getByText('Username changed. Other devices have been signed out.')).toBeTruthy();
	for (const input of document.querySelectorAll<HTMLInputElement>('input[type=password]'))
		expect(input.value).toBe('');
	expect((screen.getByLabelText('Username') as HTMLInputElement).value).toBe('next');
});

it('confirmation never reaches the API and pending disables both form paths', async () => {
	const pending = Promise.withResolvers<{ success: boolean }>();
	const change = vi.spyOn(auth, 'changePassword').mockImplementation(() => {
		auth.credentialPending = true;
		return pending.promise;
	});
	render(AuthenticationSection);
	const form = screen.getByRole('form', { name: 'Change password' });
	await fireEvent.input(within(form).getByLabelText('Current password'), {
		target: { value: 'before-password' },
	});
	await fireEvent.input(screen.getByLabelText('New password'), {
		target: { value: 'after-password' },
	});
	await fireEvent.input(screen.getByLabelText('Confirm password'), {
		target: { value: 'mismatch' },
	});
	await fireEvent.submit(form);
	expect(change).not.toHaveBeenCalled();
	expect(screen.getByLabelText('Confirm password').getAttribute('aria-invalid')).toBe('true');
	expect(
		(within(form).getByRole('button', { name: 'Change password' }) as HTMLButtonElement).disabled,
	).toBe(true);
	await fireEvent.input(screen.getByLabelText('Confirm password'), {
		target: { value: 'after-password' },
	});
	expect(screen.getByLabelText('Confirm password').getAttribute('aria-invalid')).toBe('false');
	void fireEvent.submit(form);
	await Promise.resolve();
	flushSync();
	expect(change).toHaveBeenCalledExactlyOnceWith({
		currentPassword: 'before-password',
		newPassword: 'after-password',
	});
	for (const button of screen.getAllByRole('button'))
		expect((button as HTMLButtonElement).disabled).toBe(true);
	pending.resolve({ success: true });
	await pending.promise;
});

it('keeps the username draft and clears current password on a form error', async () => {
	vi.spyOn(auth, 'changeUsername').mockResolvedValue({
		success: false,
		error: 'Incorrect current password',
	});
	render(AuthenticationSection);
	const form = screen.getByRole('form', { name: 'Change username' });
	await fireEvent.input(screen.getByLabelText('Username'), { target: { value: 'next' } });
	await fireEvent.input(within(form).getByLabelText('Current password'), {
		target: { value: 'incorrect' },
	});
	await fireEvent.submit(form);
	expect(screen.getByRole('alert').textContent).toBe('Incorrect current password');
	expect((screen.getByLabelText('Username') as HTMLInputElement).value).toBe('next');
	expect((within(form).getByLabelText('Current password') as HTMLInputElement).value).toBe('');
	expect(auth.isAuthenticated).toBe(true);
});

it('reveals fields independently without submitting or changing their values', async () => {
	const changeUsername = vi.spyOn(auth, 'changeUsername');
	const changePassword = vi.spyOn(auth, 'changePassword');
	render(AuthenticationSection);
	const passwords = Array.from(document.querySelectorAll<HTMLInputElement>('input[type=password]'));
	expect(passwords).toHaveLength(4);
	for (const input of passwords) {
		await fireEvent.input(input, { target: { value: ' exact password ' } });
		const toggle = document.querySelector<HTMLButtonElement>(
			`button[aria-controls="${input.id}"]`,
		)!;
		expect(toggle.type).toBe('button');
		expect(toggle.getAttribute('aria-label')).toBe('Show password');
		await fireEvent.click(toggle);
		expect(input.type).toBe('text');
		expect(input.value).toBe(' exact password ');
		expect(toggle.getAttribute('aria-label')).toBe('Hide password');
		expect(toggle.title).toBe('Hide password');
		for (const other of passwords.filter((other) => other !== input))
			expect(other.type).toBe('password');
		await fireEvent.click(toggle);
		expect(input.type).toBe('password');
	}
	expect(changeUsername).not.toHaveBeenCalled();
	expect(changePassword).not.toHaveBeenCalled();
});

it.each(['cleared', 'suspended'] as const)('masks revealed passwords when %s', async (reason) => {
	render(AuthenticationSection);
	const input = screen.getByLabelText('New password') as HTMLInputElement;
	await fireEvent.input(input, { target: { value: 'after-password' } });
	await fireEvent.click(document.querySelector('button[aria-controls="account-new-password"]')!);
	expect(input.type).toBe('text');
	if (reason === 'cleared') await fireEvent.input(input, { target: { value: '' } });
	else
		flushSync(() => {
			auth.availability = 'reauth-required';
		});
	expect(input.value).toBe('');
	expect(input.type).toBe('password');
	flushSync(() => {
		auth.availability = 'active';
	});
	await fireEvent.input(input, { target: { value: 'next-password' } });
	expect(input.type).toBe('password');
});
