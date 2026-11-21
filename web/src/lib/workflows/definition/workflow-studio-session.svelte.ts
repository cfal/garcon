import { createContext, onDestroy, untrack } from 'svelte';
import { ApiError } from '$lib/api/client';
import {
	getWorkflowRevision,
	publishWorkflowDefinition,
	startWorkflowRun,
	testWorkflowDraft,
} from '$lib/api/workflows';
import type {
	WorkflowPublishRequest,
	WorkflowStartRequest,
	WorkflowTestRequest,
} from '$shared/workflow-runs';
import * as m from '$lib/paraglide/messages.js';
import { isUnconfirmedWorkflowMutation } from '../workflow-mutation';
import type { WorkflowLaunchContext } from '$lib/workflows/launch/workflow-locations';
import type { WorkflowDraftState } from './workflow-draft-state.svelte';

type Launch = WorkflowStartRequest | WorkflowTestRequest;
type Observer = { launched(id: string): void; published(): void };

class WorkflowStudioSession {
	current = $state.raw<{ draft: WorkflowDraftState; context: WorkflowLaunchContext | null } | null>(
		null,
	);
	busy = $state(false);
	error = $state<string | null>(null);
	notice = $state<string | null>(null);
	pendingLaunch = $state.raw<Launch | null>(null);
	startedRun = $state.raw<{ id: string; name: string } | null>(null);
	pendingPublish = $state.raw<{
		request: WorkflowPublishRequest;
		draft: WorkflowDraftState;
	} | null>(null);
	#observer: Observer | null = null;

	get locked(): boolean {
		return this.busy || !!this.pendingLaunch || !!this.pendingPublish;
	}

	get needsExitGuard(): boolean {
		const draft = this.current?.draft;
		return (
			this.locked || Boolean(draft?.dirty || draft?.file?.busy || draft?.file?.reconcileRequired)
		);
	}

	observe(observer: Observer): () => void {
		this.#observer = observer;
		return () => {
			if (this.#observer === observer) this.#observer = null;
		};
	}

	async launch(request: Launch): Promise<void> {
		if (this.busy || this.pendingPublish || (this.pendingLaunch && this.pendingLaunch !== request))
			return;
		this.busy = true;
		this.error = null;
		this.startedRun = null;
		try {
			const run = await ('source' in request
				? testWorkflowDraft(request)
				: startWorkflowRun(request));
			this.pendingLaunch = null;
			this.startedRun = { id: run.id, name: run.name };
			this.#observer?.launched(run.id);
		} catch (error) {
			this.pendingLaunch = isUnconfirmedWorkflowMutation(error) ? request : null;
			this.error = this.pendingLaunch ? m.workflow_studio_launch_unconfirmed() : failure(error);
		} finally {
			this.busy = false;
		}
	}

	async publish(draft: WorkflowDraftState): Promise<void> {
		if (this.locked || draft !== this.current?.draft || !draft.result.definition) return;
		const request = {
			definitionId: draft.definitionId,
			expectedRevision: draft.revision,
			source: draft.source,
		};
		this.busy = true;
		this.error = null;
		this.notice = null;
		try {
			const result = await publishWorkflowDefinition(request);
			draft.acceptPublished(result);
			this.notice = m.workflow_studio_published({ revision: result.revision ?? '' });
			this.#observer?.published();
		} catch (error) {
			if (isUnconfirmedWorkflowMutation(error)) this.pendingPublish = { request, draft };
			this.error = this.pendingPublish ? m.workflow_studio_publish_unconfirmed() : failure(error);
		} finally {
			this.busy = false;
		}
	}

	async checkPublish(): Promise<void> {
		const pending = this.pendingPublish;
		if (!pending || this.busy) return;
		const { request, draft } = pending;
		this.busy = true;
		try {
			const latest = await getWorkflowRevision(request.definitionId);
			this.pendingPublish = null;
			this.error = null;
			if (
				latest.source === request.source &&
				latest.revision !== null &&
				latest.revision > (request.expectedRevision ?? 0)
			) {
				draft.acceptPublished(latest);
				this.notice = m.workflow_studio_published({ revision: latest.revision });
				this.#observer?.published();
			} else if (latest.revision !== request.expectedRevision) {
				this.error = m.workflow_studio_publish_conflict();
				this.#observer?.published();
			}
		} catch (error) {
			if (request.expectedRevision === null && error instanceof ApiError && error.status === 404) {
				this.pendingPublish = null;
				this.error = null;
			} else this.error = failure(error);
		} finally {
			this.busy = false;
		}
	}

	replace(draft: WorkflowDraftState, context: WorkflowLaunchContext | null): void {
		this.clear();
		this.current = { draft, context };
	}

	clear(): void {
		this.current?.draft.file?.dispose();
		this.current = null;
		this.startedRun = null;
		this.notice = this.error = null;
	}
}

function failure(error: unknown): string {
	return error instanceof Error ? error.message : m.workflow_studio_action_failed();
}

const [getSession, setSession] = createContext<WorkflowStudioSession>();
export { getSession as getWorkflowStudioSession };

export function provideWorkflowStudioSession(isTabOpen: () => boolean): void {
	const session = setSession(new WorkflowStudioSession());
	const tabOpen = $derived(isTabOpen());
	$effect(() => {
		if (tabOpen) return;
		untrack(() => {
			if (!session.needsExitGuard) session.clear();
		});
	});
	$effect(() => {
		if (!session.needsExitGuard) return;
		const warn = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			event.returnValue = '';
		};
		window.addEventListener('beforeunload', warn);
		return () => window.removeEventListener('beforeunload', warn);
	});
	onDestroy(() => session.clear());
}
