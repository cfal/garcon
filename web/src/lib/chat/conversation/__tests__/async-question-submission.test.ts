import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/client.js';
import type { AcceptedInputSubmissionService } from '../accepted-input-submission-service.js';
import { submitAsyncQuestionReply } from '../async-question-submission.js';
import { CommandOutcomeUnknownError } from '../idempotent-command.js';

const target = { chatId: 'chat', transcriptViewId: 'view', expectedAgentId: 'codex', expectedAgentOwnershipEpoch: 'epoch' };
const reply = { questionId: 'question', question: 'Which environment?', answer: 'Staging', source: { chatId: 'chat', transcriptViewId: 'view', ordinal: 3 } };

function service() {
	const runSubmit = vi.fn().mockResolvedValue({});
	const steerSubmit = vi.fn().mockResolvedValue({});
	const inputs = {
		run: vi.fn(() => ({ clientRequestId: 'run', clientMessageId: 'run-message', submit: runSubmit })),
		steer: vi.fn(() => ({ clientRequestId: 'steer', clientMessageId: 'steer-message', submit: steerSubmit })),
	} satisfies Pick<AcceptedInputSubmissionService, 'run' | 'steer'>;
	return { inputs, runSubmit, steerSubmit };
}

describe('async reply delivery', () => {
	it('starts when idle, carrying exact source and ownership without composer operations', async () => {
		const { inputs } = service();
		expect(await submitAsyncQuestionReply(target, reply, [], inputs)).toBe('new-turn');
		expect(inputs.run).toHaveBeenCalledWith({ ...target, questionReply: reply, command: '> Which environment?\n\nStaging', excludedResendOrdinals: [] });
		expect(inputs.steer).not.toHaveBeenCalled();
	});
	it('steers a busy turn without queueing', async () => {
		const { inputs, runSubmit } = service();
		runSubmit.mockRejectedValue(new ApiError(409, 'Busy', 'SESSION_BUSY'));
		expect(await submitAsyncQuestionReply(target, reply, [2], inputs)).toBe('steer');
		expect(inputs.steer).toHaveBeenCalledWith({ ...target, questionReply: reply, content: '> Which environment?\n\nStaging', whenTurnUnavailable: 'reject' });
	});
	it('reuses the original run identity only after definitive steer state conflicts', async () => {
		const { inputs, runSubmit, steerSubmit } = service();
		runSubmit.mockRejectedValueOnce(new ApiError(409, 'Busy', 'SESSION_BUSY'));
		steerSubmit.mockRejectedValue(new ApiError(409, 'Ended', 'STEER_TURN_UNAVAILABLE'));
		const excluded = [2];
		const submission = submitAsyncQuestionReply(target, reply, excluded, inputs);
		excluded.push(4);
		expect(await submission).toBe('new-turn');
		expect(inputs.run).toHaveBeenCalledTimes(1);
		expect(inputs.run).toHaveBeenCalledWith(expect.objectContaining({ excludedResendOrdinals: [2] }));
		expect(runSubmit).toHaveBeenCalledTimes(2);
	});
	it.each([
		new CommandOutcomeUnknownError(), new ApiError(500, 'Unknown', 'STEER_TURN_CHANGED'),
		new ApiError(500, 'Not delivered after admission', 'STEER_NOT_DELIVERED'),
		new ApiError(409, 'Rejected', 'STEER_PROVIDER_REJECTED'), new ApiError(409, 'Unsupported', 'OPERATION_UNSUPPORTED'),
	])('never switches routes after ambiguous delivery or provider rejection: %s', async error => {
		const { inputs, runSubmit, steerSubmit } = service();
		runSubmit.mockRejectedValue(new ApiError(409, 'Busy', 'SESSION_BUSY'));
		steerSubmit.mockRejectedValue(error);
		await expect(submitAsyncQuestionReply(target, reply, [], inputs)).rejects.toBe(error);
		expect(runSubmit).toHaveBeenCalledTimes(1);
		expect(steerSubmit).toHaveBeenCalledTimes(1);
	});
	it('bounds run/steer races', async () => {
		const { inputs, runSubmit, steerSubmit } = service();
		runSubmit.mockRejectedValue(new ApiError(409, 'Busy', 'SESSION_BUSY'));
		steerSubmit.mockRejectedValue(new ApiError(409, 'Ended', 'STEER_TURN_CHANGED'));
		await expect(submitAsyncQuestionReply(target, reply, [], inputs)).rejects.toMatchObject({ errorCode: 'SESSION_BUSY' });
		expect(runSubmit).toHaveBeenCalledTimes(2);
		expect(steerSubmit).toHaveBeenCalledTimes(1);
	});
});
