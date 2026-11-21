import { EditorView } from '@codemirror/view';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '$lib/api/workflows';
import * as files from '$lib/api/files';
import { parseWorkflowDefinition } from '$shared/workflow-definition';
import { WorkflowFileState } from '$lib/workflows/definition/workflow-file-state.svelte';
import { WorkflowDraftState } from '$lib/workflows/definition/workflow-draft-state.svelte';
import { workflowRevision, workflowRun } from '$lib/workflows/__tests__/workflow-fixtures';
import NewWorkflowTestHost from './NewWorkflowTestHost.svelte';
import WorkflowDefinitionEditor from '../WorkflowDefinitionEditor.svelte';

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
	vi.spyOn(files, 'getTree').mockResolvedValue({
		fileRootPath: '/project',
		directory: {
			path: '/project',
			relativePath: '',
			parentPath: null,
			breadcrumbs: [{ name: 'project', path: '/project' }],
		},
		homeDirectory: null,
		entries: [],
	});
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
	vi.restoreAllMocks();
	vi.resetAllMocks();
});

describe('New Workflow', () => {
	it('allows joining decisions but offers output bindings only for groups with final text', async () => {
		const source = `version: 1
name: Review each
steps:
  - {id: research, kind: agent, prompt: Find, signals: {item: {delivery: many, key: id, payload: json, fields: {id: string}}}}
  - {id: check, kind: command, command: pwd, on: {kind: each, signal: research.item}}
  - {id: approve, kind: decision, prompt: Review, choices: {ok: Approve}, on: {kind: each, signal: research.item}}
  - {id: summary, kind: agent, prompt: Summarize, on: {kind: all, close: research.turn_completed, steps: [check, approve]}}
`;
		const draft = new WorkflowDraftState(source);
		render(WorkflowDefinitionEditor, {
			props: { draft, context: null, busy: false, onPublish: vi.fn(), onTest: vi.fn() },
		});
		await fireEvent.click(screen.getByRole('button', { name: /summary Agent/i }));
		expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'approve' }).checked).toBe(true);
		await fireEvent.click(screen.getByRole('button', { name: 'Add binding' }));
		const choices = [...screen.getByLabelText<HTMLSelectElement>('Binding source').options].map(
			(option) => option.value,
		);
		expect(choices).toContain('all.check');
		expect(choices).not.toContain('all.approve');
	});

	it('keeps the draft test folder but uses the newly opened chat context for a published run', async () => {
		const { source, definition } = workflowRun().pinnedRevision;
		vi.mocked(api.getWorkflowRevision).mockResolvedValue({
			...workflowRevision(),
			source,
			definition,
		});
		const props = {
			onRunStarted: vi.fn(),
			open: true,
			context: { executorId: 'local', cwd: '/first' },
		};
		const host = render(NewWorkflowTestHost, { props });
		await fireEvent.click(screen.getByRole('button', { name: 'Definition editor' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Paste definition' }));
		const dialog = within(screen.getByRole('dialog', { name: 'Paste definition' }));
		await fireEvent.input(dialog.getByLabelText('YAML source'), { target: { value: source } });
		await fireEvent.click(dialog.getByRole('button', { name: 'Paste definition' }));
		await host.rerender({ ...props, open: false });
		await host.rerender({ ...props, context: { executorId: 'remote', cwd: '/second' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Test run' }));
		expect(screen.getByDisplayValue('/first')).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'New run' }));
		await screen.findByRole('option', { name: 'Review a report · Revision 3' });
		await fireEvent.change(screen.getByLabelText('Definition'), {
			target: { value: 'review-def:3' },
		});
		expect(await screen.findByDisplayValue('/second')).toBeTruthy();
		expect(screen.queryByDisplayValue('/first')).toBeNull();
	});

	it('keeps an in-flight launch locked across remounts and retries the exact unconfirmed request', async () => {
		const first = Promise.withResolvers<Awaited<ReturnType<typeof api.testWorkflowDraft>>>();
		vi.mocked(api.testWorkflowDraft)
			.mockReturnValueOnce(first.promise)
			.mockResolvedValueOnce(workflowRun());
		const props = { onRunStarted: vi.fn(), open: true };
		const host = render(NewWorkflowTestHost, props);
		await fireEvent.click(screen.getByRole('button', { name: 'Definition editor' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Test run' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Test run' }));
		expect(api.testWorkflowDraft).toHaveBeenCalledOnce();
		await host.rerender({ ...props, open: false });
		await host.rerender(props);
		expect(screen.getByRole<HTMLButtonElement>('button', { name: 'New run' }).disabled).toBe(true);
		first.reject(new Error('Lost reply'));
		await screen.findByRole('button', { name: 'Retry same launch' });
		await host.rerender({ ...props, open: false });
		await host.rerender(props);
		await fireEvent.click(screen.getByRole('button', { name: 'Retry same launch' }));
		expect(vi.mocked(api.testWorkflowDraft).mock.calls[1]).toEqual(
			vi.mocked(api.testWorkflowDraft).mock.calls[0],
		);
		await waitFor(() => expect(props.onRunStarted).toHaveBeenCalledExactlyOnceWith('run-a'));
	});

	it('links to the confirmed run when a launch finishes while the Studio is closed', async () => {
		const reply = Promise.withResolvers<Awaited<ReturnType<typeof api.testWorkflowDraft>>>();
		vi.mocked(api.testWorkflowDraft).mockReturnValueOnce(reply.promise);
		const props = { onRunStarted: vi.fn(), open: true };
		const host = render(NewWorkflowTestHost, props);
		await fireEvent.click(screen.getByRole('button', { name: 'Definition editor' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Test run' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Test run' }));
		await host.rerender({ ...props, open: false });
		const canUnload = () => window.dispatchEvent(new Event('beforeunload', { cancelable: true }));
		expect(canUnload()).toBe(false);
		reply.resolve(workflowRun());
		await waitFor(() => expect(canUnload()).toBe(true));
		await host.rerender(props);
		expect(props.onRunStarted).not.toHaveBeenCalled();
		await fireEvent.click(await screen.findByRole('button', { name: /Open started run/ }));
		expect(props.onRunStarted).toHaveBeenCalledExactlyOnceWith('run-a');
		expect(api.testWorkflowDraft).toHaveBeenCalledOnce();
		await host.rerender({ ...props, open: false });
		await host.rerender(props);
		expect(screen.queryByRole('button', { name: /Open started run/ })).toBeNull();
	});

	it('keeps a clean file draft on presentation replacement but releases it on tab close', async () => {
		const path = '/project/review.workflow.yaml';
		const read = vi.spyOn(files, 'readText').mockResolvedValue({
			path,
			content: workflowRevision().source,
			revision: 'v1:read',
		});
		const props = {
			onRunStarted: vi.fn(),
			open: true,
			context: { executorId: 'local', cwd: '/project' },
		};
		const host = render(NewWorkflowTestHost, { props });
		await fireEvent.click(screen.getByRole('button', { name: 'Definition editor' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Open source file' }));
		const picker = within(screen.getByRole('dialog', { name: 'Open source file' }));
		await fireEvent.input(picker.getByLabelText('File path'), { target: { value: path } });
		await fireEvent.click(picker.getByRole('button', { name: 'Open source file' }));
		await screen.findByRole('button', { name: 'Publish new definition' });
		await host.rerender({ ...props, context: { executorId: 'remote', cwd: '/another' } });
		expect(screen.getByRole('button', { name: 'Publish new definition' })).toBeTruthy();
		expect(screen.getByText(path, { exact: false })).toBeTruthy();
		expect(read).toHaveBeenCalledOnce();
		expect(read.mock.calls[0][0]).toEqual({
			executorId: 'local',
			projectPath: '/project',
			filePath: path,
		});
		await host.rerender({ ...props, open: false });
		await host.rerender(props);
		expect(screen.getByLabelText('Definition')).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Publish new definition' })).toBeNull();
	});

	it('opens a relative file against the selected executor and chat folder, without looking up a different root', async () => {
		const path = '/worker/project/review.workflow.yaml';
		const read = vi.spyOn(files, 'readText').mockResolvedValue({
			path,
			content: workflowRevision().source,
			revision: 'v1:read',
		});
		render(NewWorkflowTestHost, {
			props: { onRunStarted: vi.fn(), context: { executorId: 'remote', cwd: '/worker/project' } },
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Definition editor' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Open source file' }));
		const picker = within(screen.getByRole('dialog', { name: 'Open source file' }));
		await fireEvent.input(picker.getByLabelText('File path'), {
			target: { value: 'review.workflow.yaml' },
		});
		await fireEvent.click(picker.getByRole('button', { name: 'Open source file' }));
		await screen.findByRole('button', { name: 'Publish new definition' });
		expect(read.mock.calls[0][0]).toEqual({
			executorId: 'remote',
			projectPath: '/worker/project',
			filePath: 'review.workflow.yaml',
		});
		expect(files.getTree).not.toHaveBeenCalled();
	});

	it('retains an unsaved draft when its presentation closes and protects it from page unload', async () => {
		const path = '/project/review.workflow.yaml';
		vi.spyOn(files, 'readText').mockResolvedValue({
			path,
			content: workflowRevision().source,
			revision: 'v1:read',
		});
		const save = vi
			.spyOn(files, 'saveText')
			.mockResolvedValue({ success: true, message: 'Saved', path, revision: 'v1:saved' });
		const props = { onRunStarted: vi.fn(), open: true };
		const host = render(NewWorkflowTestHost, props);
		const unload = () => window.dispatchEvent(new Event('beforeunload', { cancelable: true }));
		expect(unload()).toBe(true);
		await fireEvent.click(screen.getByRole('button', { name: 'Definition editor' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Open source file' }));
		const picker = within(screen.getByRole('dialog', { name: 'Open source file' }));
		await fireEvent.input(picker.getByLabelText('File path'), { target: { value: path } });
		await fireEvent.click(picker.getByRole('button', { name: 'Open source file' }));
		expect(await screen.findByRole('button', { name: 'Publish new definition' })).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: /Review report/ }));
		await fireEvent.input(screen.getByLabelText('Step name'), {
			target: { value: 'Retained review' },
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Apply step edits' }));
		await host.rerender({ ...props, open: false });
		expect(unload()).toBe(false);
		await host.rerender(props);
		expect(screen.getByRole('button', { name: /Retained review/ })).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Save draft file' }));
		expect(save.mock.calls[0]?.[0]).toMatchObject({
			executorId: 'local',
			projectPath: '/project',
			filePath: path,
			expectedRevision: 'v1:read',
		});
		await waitFor(() => expect(unload()).toBe(true));
		host.unmount();
		expect(unload()).toBe(true);
	});

	it('blocks graph edits while comparing a file draft with disk', async () => {
		const path = '/project/example.workflow.yaml';
		const { source } = workflowRevision();
		const read = vi
			.spyOn(files, 'readText')
			.mockResolvedValue({ path, content: source, revision: 'v1:old' });
		const file = await WorkflowFileState.open(files, {
			executorId: 'local',
			projectPath: '/project',
			filePath: path,
		});
		const draft = new WorkflowDraftState(source, { file });
		draft.replaceSource(source + '# Local edit\n');
		read.mockResolvedValue({ path, content: source + '# Disk edit\n', revision: 'v1:new' });
		await file.compare(() => draft.source);
		render(WorkflowDefinitionEditor, {
			props: { draft, context: null, busy: false, onPublish: vi.fn(), onTest: vi.fn() },
		});
		expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Edit graph' }).disabled).toBe(
			true,
		);
		expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Add step' }).disabled).toBe(true);
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Add step' }).disabled).toBe(
			false,
		);
		expect(draft.source).toBe(source + '# Local edit\n');
	});

	it('keeps a valid input named constructor editable after validating other fields', async () => {
		const revision = workflowRevision();
		const source = revision.source.replace('  title:', '  constructor:');
		const { definition } = parseWorkflowDefinition(source);
		if (!definition) throw new Error('Invalid synthetic workflow');
		vi.mocked(api.getWorkflowRevision).mockResolvedValue({ ...revision, definition, source });
		render(NewWorkflowTestHost, { onRunStarted: vi.fn() });
		await screen.findByRole('option', { name: 'Review a report · Revision 3' });
		await fireEvent.change(screen.getByLabelText('Definition'), {
			target: { value: 'review-def:3' },
		});
		const input = await screen.findByLabelText(/^constructor/);
		await fireEvent.input(input, { target: { value: 'Review' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Start workflow' }));
		expect(screen.getAllByText('Enter a value.')).toHaveLength(3);
		expect(screen.getByLabelText(/^constructor/)).toBe(input);
	});

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
		await fireEvent.click(screen.getByRole('button', { name: 'Definition editor' }));
		expect(screen.queryByRole('button', { name: /Open started run/ })).toBeNull();
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

	it('recovers the recent list on Refresh and ignores an older outstanding response', async () => {
		const old = Promise.withResolvers<Awaited<ReturnType<typeof api.listWorkflowRunsPage>>>();
		vi.mocked(api.listWorkflowRunsPage)
			.mockReturnValueOnce(old.promise)
			.mockRejectedValueOnce(new Error('Recent runs unavailable'))
			.mockResolvedValueOnce({ items: [workflowRun()], nextCursor: null });
		render(NewWorkflowTestHost, { onRunStarted: vi.fn() });
		await screen.findByRole('option', { name: 'Review a report · Revision 3' });
		const refresh = screen.getByRole('button', { name: 'Refresh' });
		await fireEvent.click(refresh);
		expect(await screen.findByText('Recent runs unavailable')).toBeTruthy();
		await fireEvent.click(refresh);
		const runButton = await screen.findByRole('button', { name: /Verify research/ });
		old.resolve({ items: [], nextCursor: null });
		await old.promise;
		await Promise.resolve();
		expect(screen.queryByText('Recent runs unavailable')).toBeNull();
		expect(runButton.isConnected).toBe(true);
	});

	it('authors input defaults, choices, and single and keyed signals with form submission', async () => {
		const { container } = render(NewWorkflowTestHost, { onRunStarted: vi.fn() });
		await fireEvent.click(screen.getByRole('button', { name: 'Definition editor' }));
		await fireEvent.click(screen.getByText('Launch input schema'));
		await fireEvent.click(screen.getByRole('button', { name: 'Add input' }));
		await fireEvent.input(screen.getByLabelText('Input name'), { target: { value: 'topic' } });
		await fireEvent.change(screen.getByLabelText('Value type'), { target: { value: 'json' } });
		await fireEvent.click(screen.getByLabelText('Supply a default'));
		await fireEvent.input(screen.getByLabelText('Default value'), {
			target: { value: '{"title":"Synthetic"}' },
		});
		await fireEvent.submit(screen.getByRole('button', { name: 'Apply input' }).closest('form')!);

		await fireEvent.click(screen.getByRole('button', { name: /review Human decision/i }));
		await fireEvent.click(screen.getByText('Choices', { selector: 'summary' }));
		await fireEvent.input(screen.getByLabelText('Prompt'), {
			target: { value: 'Unapplied prompt' },
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Add choice' }));
		await fireEvent.input(screen.getByLabelText('Choice ID'), { target: { value: 'defer' } });
		await fireEvent.input(screen.getByLabelText('Choice label'), {
			target: { value: 'Defer review' },
		});
		await fireEvent.submit(screen.getByRole('button', { name: 'Apply choice' }).closest('form')!);
		expect(screen.getByLabelText<HTMLTextAreaElement>('Prompt').value).toBe('Unapplied prompt');

		await fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
		const picker = screen.getByRole('dialog', { name: 'Add step' });
		await fireEvent.click(within(picker).getByRole('button', { name: 'Agent' }));
		await fireEvent.click(screen.getByText('Emitted signals', { selector: 'summary' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Add signal' }));
		await fireEvent.input(screen.getByLabelText('Signal name'), { target: { value: 'ready' } });
		await fireEvent.submit(screen.getByRole('button', { name: 'Apply signal' }).closest('form')!);
		await fireEvent.click(screen.getByRole('button', { name: 'Add signal' }));
		await fireEvent.input(screen.getByLabelText('Signal name'), { target: { value: 'finding' } });
		await fireEvent.change(screen.getByLabelText('Signal payload'), { target: { value: 'json' } });
		await fireEvent.click(screen.getByLabelText('Repeat per key'));
		await fireEvent.click(screen.getByRole('button', { name: 'Add field' }));
		await fireEvent.input(screen.getByLabelText('Field name'), { target: { value: 'id' } });
		await fireEvent.change(screen.getByLabelText('Repeat key'), { target: { value: 'id' } });
		await fireEvent.submit(screen.getByRole('button', { name: 'Apply signal' }).closest('form')!);

		await fireEvent.click(screen.getByRole('button', { name: 'YAML source' }));
		await waitFor(() => expect(container.querySelector('.cm-editor')).toBeTruthy(), {
			timeout: 10_000,
		});
		const editor = EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!;
		const parsed = parseWorkflowDefinition(editor.state.doc.toString());
		expect(parsed.diagnostics).toEqual([]);
		expect(parsed.definition).toMatchObject({
			inputs: { topic: { type: 'json', default: { title: 'Synthetic' } } },
			steps: [
				{ id: 'review', choices: { defer: 'Defer review' } },
				{
					id: 'agent',
					signals: {
						ready: { payload: 'none', delivery: 'once' },
						finding: { payload: 'json', delivery: 'many', key: 'id', fields: { id: 'string' } },
					},
				},
			],
		});
	}, 20_000);
});
