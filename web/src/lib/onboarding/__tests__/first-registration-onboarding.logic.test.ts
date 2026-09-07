import { describe, expect, it } from 'vitest';
import { resolveFirstRegistrationOnboarding } from '../first-registration-onboarding';

describe('resolveFirstRegistrationOnboarding', () => {
	it.each([
		{ isLoading: true, isAuthenticated: false },
		{ isLoading: false, isAuthenticated: false },
	])('waits until authentication is ready for %#', ({ isLoading, isAuthenticated }) => {
		expect(
			resolveFirstRegistrationOnboarding({
				isLoading,
				isAuthenticated,
				authDisabled: false,
				isRegistrationRoute: false,
				justRegistered: true,
			}),
		).toBe('wait');
	});

	it('ignores auth-disabled sessions', () => {
		expect(
			resolveFirstRegistrationOnboarding({
				isLoading: false,
				isAuthenticated: true,
				authDisabled: true,
				isRegistrationRoute: false,
				justRegistered: true,
			}),
		).toBe('ignore');
	});

	it('ignores existing authenticated users', () => {
		expect(
			resolveFirstRegistrationOnboarding({
				isLoading: false,
				isAuthenticated: true,
				authDisabled: false,
				isRegistrationRoute: false,
				justRegistered: false,
			}),
		).toBe('ignore');
	});

	it('opens only for a newly registered authenticated user', () => {
		expect(
			resolveFirstRegistrationOnboarding({
				isLoading: false,
				isAuthenticated: true,
				authDisabled: false,
				isRegistrationRoute: false,
				justRegistered: true,
			}),
		).toBe('open');
	});

	it('waits for registration navigation before reading the success flag', () => {
		expect(
			resolveFirstRegistrationOnboarding({
				isLoading: false,
				isAuthenticated: true,
				authDisabled: false,
				isRegistrationRoute: true,
				justRegistered: false,
			}),
		).toBe('wait');

		expect(
			resolveFirstRegistrationOnboarding({
				isLoading: false,
				isAuthenticated: true,
				authDisabled: false,
				isRegistrationRoute: false,
				justRegistered: true,
			}),
		).toBe('open');
	});
});
