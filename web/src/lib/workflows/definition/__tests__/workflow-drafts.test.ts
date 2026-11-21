import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/client';
import type { readText, saveText } from '$lib/api/files';
import { WorkflowFileState } from '../workflow-file-state.svelte';
import { WorkflowDraftState } from '../workflow-draft-state.svelte';
import { workflowRevision } from '../../__tests__/workflow-fixtures';

describe('workflow draft', () => {
	it('retains comments and the exact source buffer across graph edit, invalid text, and undo', () => {
		const revision = workflowRevision();
		const draft = new WorkflowDraftState(revision.source, { definition: revision });
		expect(draft.edit([{ kind: 'upsert', path: ['steps', 0, 'name'], value: 'Updated' }])).toBe(
			true,
		);
		const updated = revision.source.replace('name: Review report', 'name: "Updated"');
		expect(draft.source).toBe(updated);
		const invalid = updated.replace('kind: decision', 'kind: nope');
		draft.replaceSource(invalid);
		expect(draft.result.definition).toBeNull();
		expect(draft.lastValid?.steps[0].name).toBe('Updated');
		expect(draft.edit([{ kind: 'upsert', path: ['name'], value: 'Must not write' }])).toBe(false);
		expect(draft.source).toBe(invalid);
		expect(draft.undo()).toBe(true);
		expect(draft.source).toBe(updated);
		expect(draft.undo()).toBe(true);
		expect(draft.source).toBe(revision.source);
		expect(draft.redo()).toBe(true);
		expect(draft.source).toBe(updated);
	});
});

describe('workflow draft file', () => {
	it('checks the owning revision, preserves typed edits after a conflict, and saves against the displayed disk revision', async () => {
		const path = '/remote/project/example.workflow.yaml';
		const read = vi
			.fn<typeof readText>()
			.mockResolvedValueOnce({ content: 'original', path, revision: 'v1:original' })
			.mockResolvedValueOnce({ content: 'on disk', path, revision: 'v1:disk' });
		const save = vi
			.fn<typeof saveText>()
			.mockRejectedValueOnce(new ApiError(409, 'File changed', 'FILE_REVISION_CONFLICT'))
			.mockResolvedValueOnce({ path, revision: 'v1:resolved', success: true, message: 'Saved' });
		const file = await WorkflowFileState.open(
			{ readText: read, saveText: save },
			{
				executorId: 'remote-a',
				projectPath: '/remote/project',
				filePath: 'example.workflow.yaml',
			},
		);
		await file.save('my edit');
		expect(save.mock.calls[0][0]).toEqual({
			executorId: 'remote-a',
			projectPath: '/remote/project',
			filePath: path,
			content: 'my edit',
			expectedRevision: 'v1:original',
			conflictResolution: 'reject',
		});
		expect(file.reconcileRequired).toBe(true);
		await file.save('newer edit');
		expect(save).toHaveBeenCalledOnce();
		await file.compare(() => 'newer edit');
		expect(read.mock.calls[1][0]).toMatchObject({ executorId: 'remote-a', filePath: path });
		expect(file.comparison?.source).toBe('newer edit');
		expect(file.acceptDisk('even newer edit')).toBeUndefined();
		const replace = vi.fn();
		await file.saveCompared('newer edit', 'merged text', replace);
		expect(replace).toHaveBeenCalledWith('merged text');
		expect(save.mock.calls[1][0]).toMatchObject({
			executorId: 'remote-a',
			content: 'merged text',
			expectedRevision: 'v1:disk',
			conflictResolution: 'reject',
		});
		expect(file.baseline).toBe('merged text');
		expect(file.reconcileRequired).toBe(false);
	});

	it('reconciles a lost confirmation without automatically saving again', async () => {
		const path = '/workspace/draft.workflow.yaml';
		const read = vi
			.fn<typeof readText>()
			.mockResolvedValueOnce({ content: 'previous', path, revision: 'v1:prev' })
			.mockResolvedValueOnce({ content: 'saved', path, revision: 'v1:next' });
		const save = vi.fn<typeof saveText>().mockRejectedValueOnce(new Error('Connection lost'));
		const file = await WorkflowFileState.open(
			{ readText: read, saveText: save },
			{ executorId: 'local', filePath: path },
		);
		await file.save('saved');
		expect(file.reconcileRequired).toBe(true);
		await file.compare(() => 'saved');
		expect(file.baseline).toBe('saved');
		expect(file.reconcileRequired).toBe(false);
		expect(save).toHaveBeenCalledOnce();
	});
});
