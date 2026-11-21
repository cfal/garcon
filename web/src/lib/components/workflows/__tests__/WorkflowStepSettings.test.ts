import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import {
	createExecutorStartupFixture,
	executorStartupSnapshot,
} from '$lib/chat/new-chat/__tests__/executor-startup-fixture';
import { ChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte';
import { createPreamblesStore } from '$lib/preambles/preambles-store.svelte';
import { AppShellStore } from '$lib/stores/app-shell.svelte';
import { LocalSettingsStore } from '$lib/stores/local-settings.svelte';
import WorkflowStepSettings from '../WorkflowStepSettings.svelte';

let deps: ReturnType<typeof createExecutorStartupFixture>;
let local: LocalSettingsStore;
vi.mock('$lib/context', async (original) => ({
	...(await original<typeof import('$lib/context')>()),
	getModelCatalog: () => deps.modelCatalog,
	getExecutors: () => deps.executors,
	getRemoteSettings: () => deps.remoteSettings,
	getLocalSettings: () => local,
	getChatSessions: () => new ChatSessionsStore(),
	getAppShell: () => new AppShellStore(),
	getPreambles: () => createPreamblesStore({ get: async () => ({ revision: 0, preambles: [] }) }),
}));

afterEach(() => {
	cleanup();
	local.destroy();
	vi.restoreAllMocks();
});

it('applies the authored agent defaults rather than the recent agent modes when restoring a model', async () => {
	deps = createExecutorStartupFixture();
	const snapshot = executorStartupSnapshot();
	snapshot.executionDefaults.byAgent.codex = {
		permissionMode: 'acceptEdits',
		thinkingMode: 'high',
	};
	deps.remoteSettings.applySnapshot(snapshot);
	local = new LocalSettingsStore();
	const onApply = vi.fn();
	render(WorkflowStepSettings, {
		props: {
			step: {
				id: 'review',
				kind: 'agent',
				agentId: 'codex',
				model: 'local-default',
				prompt: 'Review',
			},
			context: null,
			narrow: false,
			disabled: false,
			onApply,
		},
	});
	const apply = screen.getByRole<HTMLButtonElement>('button', { name: 'Apply settings' });
	await waitFor(() => expect(apply.disabled).toBe(false));
	await fireEvent.click(apply);
	expect(onApply).toHaveBeenCalledWith(
		expect.objectContaining({
			agentId: 'codex',
			model: 'local-default',
			permissionMode: 'acceptEdits',
			thinkingMode: 'high',
		}),
	);
});
