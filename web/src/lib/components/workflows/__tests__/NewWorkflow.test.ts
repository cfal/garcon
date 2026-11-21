import { EditorView } from '@codemirror/view';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '$lib/api/workflows';
import { workflowRevision, workflowRun } from '$lib/workflows/__tests__/workflow-fixtures';
import NewWorkflowTestHost from './NewWorkflowTestHost.svelte';

vi.mock('$lib/api/workflows', () => ({
	listWorkflowDefinitionsPage: vi.fn(),
	listWorkflowRunsPage: vi.fn(),
	getWorkflowRevision: vi.fn(),
	startWorkflowRun: vi.fn(),
	publishWorkflowDefinition: vi.fn(),
	testWorkflowDraft: vi.fn(),
}));

beforeEach(() => {
	const revision = workflowRevision();
	vi.mocked(api.listWorkflowDefinitionsPage).mockResolvedValue({
		items: [
			{
				id: 'review-def',
				revision: 3,
				name: revision.definition.name,
				publishedAt: revision.publishedAt!,
				inputs: revision.definition.inputs,
			},
		],
		nextCursor: null,
	});
	vi.mocked(api.listWorkflowRunsPage).mockResolvedValue({ items: [], nextCursor: null });
	vi.mocked(api.getWorkflowRevision).mockResolvedValue(revision);
	vi.mocked(api.startWorkflowRun).mockResolvedValue(workflowRun());
});

afterEach(() => {
	cleanup();
	vi.resetAllMocks();
});

describe('New Workflow', () => {
	it('requires an explicit revision and submits typed launch inputs with the pinned revision', async () => {
		const open = vi.fn();
		render(NewWorkflowTestHost, { onRunStarted: open });
		await screen.findByRole('option', { name: 'Review a report · Revision 3' });
		expect(screen.queryByRole('button', { name: 'Start workflow' })).toBeNull();
		await fireEvent.change(screen.getByLabelText('Definition'), {
			target: { value: 'review-def:3' },
		});
		const start = await screen.findByRole('button', { name: 'Start workflow' });
		await fireEvent.click(start);
		expect(api.startWorkflowRun).not.toHaveBeenCalled();
		expect(screen.getAllByText('Enter a value.')).toHaveLength(4);

		await fireEvent.input(screen.getByLabelText(/^title/), { target: { value: 'A report' } });
		await fireEvent.input(screen.getByLabelText(/^count/), { target: { value: '0' } });
		await fireEvent.change(screen.getByLabelText(/^failed/), { target: { value: 'false' } });
		await fireEvent.input(screen.getByLabelText(/^evidence/), { target: { value: 'null' } });
		await fireEvent.click(start);
		await waitFor(() => expect(open).toHaveBeenCalledWith('run-a'));
		expect(api.startWorkflowRun).toHaveBeenCalledWith({
			definitionId: 'review-def',
			revision: 3,
			operationId: expect.any(String),
			inputs: { title: 'A report', count: 0, failed: false, evidence: null },
			executionContext: {},
		});
	});

	it('imports an independent draft, edits it from the outline, and blocks publishing or testing invalid source', async () => {
		const { container } = render(NewWorkflowTestHost, { onRunStarted: vi.fn() });
		await fireEvent.click(screen.getByRole('button', { name: 'Definition editor' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Paste definition' }));
		const importDialog = screen.getByRole('dialog', { name: 'Paste definition' });
		await fireEvent.input(within(importDialog).getByLabelText('YAML source'), {
			target: { value: workflowRevision().source },
		});
		await fireEvent.click(within(importDialog).getByRole('button', { name: 'Paste definition' }));
		expect(api.publishWorkflowDefinition).not.toHaveBeenCalled();
		expect(api.testWorkflowDraft).not.toHaveBeenCalled();

		await fireEvent.click(screen.getByRole('button', { name: /Review report/ }));
		await fireEvent.input(screen.getByLabelText('Step name'), {
			target: { value: 'Updated review' },
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Apply step edits' }));
		expect(screen.getByRole('button', { name: /Updated review/ })).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'YAML source' }));
		await waitFor(() => expect(container.querySelector('.cm-editor')).toBeTruthy(), {
			timeout: 10_000,
		});
		const editor = EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!;
		const source = editor.state.doc.toString();
		expect(source).toContain('# Reviewed source comment');
		expect(source).toContain('# preserve inline comment');
		expect(source).toContain('name: "Updated review"');
		const at = source.indexOf('kind: decision') + 'kind: '.length;
		editor.dispatch({ changes: { from: at, to: at + 'decision'.length, insert: 'bogus' } });
		const diagnostic = await screen.findByRole('button', { name: /kind|one of/ });
		await fireEvent.click(diagnostic);
		const { from, to } = editor.state.selection.main;
		expect(editor.state.doc.sliceString(from, to)).toBe('bogus');
		expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(
			true,
		);
		expect((screen.getByRole('button', { name: 'Test run' }) as HTMLButtonElement).disabled).toBe(
			true,
		);
		await fireEvent.click(screen.getByRole('button', { name: 'Outline' }));
		expect(await screen.findByText(/last valid source/)).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Add step' })).toBeNull();
	}, 20_000);

	it('starts a separate draft run and only publishes on explicit request', async () => {
		const open = vi.fn();
		vi.mocked(api.testWorkflowDraft).mockResolvedValue({ ...workflowRun(), kind: 'test' });
		vi.mocked(api.publishWorkflowDefinition).mockImplementation(async (request) => ({
			...workflowRevision(),
			source: request.source,
			definitionId: request.definitionId,
			revision: 1,
		}));
		render(NewWorkflowTestHost, { onRunStarted: open });
		await fireEvent.click(screen.getByRole('button', { name: 'Definition editor' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Test run' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Test run' }));
		await waitFor(() => expect(open).toHaveBeenCalledWith('run-a'));
		const testRequest = vi.mocked(api.testWorkflowDraft).mock.calls[0][0];
		expect(testRequest).toMatchObject({
			inputs: {},
			executionContext: {},
			operationId: expect.any(String),
		});
		expect(api.publishWorkflowDefinition).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByRole('button', { name: 'Back to editor' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
		expect(await screen.findByText('Published revision 1.')).toBeTruthy();
		expect(api.publishWorkflowDefinition).toHaveBeenCalledExactlyOnceWith({
			definitionId: expect.any(String),
			expectedRevision: null,
			source: testRequest.source,
		});
	});
});
