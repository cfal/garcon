import { describe, expect, it, vi } from 'vitest';
import type { AcceptedInputTransport } from '../accepted-input-submission-service.js';
import { AcceptedInputSubmissionService } from '../accepted-input-submission-service.js';

function transport(overrides: Partial<AcceptedInputTransport> = {}): AcceptedInputTransport {
	return {
		start: vi.fn(),
		run: vi.fn(),
		fork: vi.fn(),
		enqueue: vi.fn(),
		steer: vi.fn(),
		goalControl: vi.fn(),
		...overrides,
	};
}

describe('AcceptedInputSubmissionService', () => {
	it('materializes a draft request once after startup state is installed', async () => {
		let agentSettings = {
			ownerId: 'direct',
			schemaVersion: 1,
			values: { phase: 'before-startup' },
		};
		const start = vi
			.fn()
			.mockRejectedValueOnce(new TypeError('connection closed'))
			.mockResolvedValueOnce({ success: true, status: 'duplicate' });
		const createInput = vi.fn(() => ({
			chatId: 'chat-1',
			agentId: 'direct',
			projectPath: '/project',
			model: 'model-1',
			permissionMode: 'default' as const,
			thinkingMode: 'none' as const,
			agentSettings,
			command: 'hello',
		}));
		const service = new AcceptedInputSubmissionService(
			transport({ start }),
			vi.fn().mockReturnValueOnce('request-1').mockReturnValueOnce('message-1'),
		);

		const submission = service.start(createInput);
		expect(createInput).not.toHaveBeenCalled();
		agentSettings = {
			ownerId: 'direct',
			schemaVersion: 1,
			values: { phase: 'after-startup' },
		};
		await submission.submit();

		expect(createInput).toHaveBeenCalledOnce();
		expect(start).toHaveBeenCalledTimes(2);
		expect(start.mock.calls[0]?.[0]).toBe(start.mock.calls[1]?.[0]);
		expect(start.mock.calls[0]?.[0]).toMatchObject({
			agentSettings: { ownerId: 'direct', values: { phase: 'after-startup' } },
		});
	});

	it('creates direct identities before submission and preserves them across retry', async () => {
		const requests: unknown[] = [];
		const run = vi
			.fn()
			.mockImplementationOnce(async (request) => {
				requests.push(request);
				throw new TypeError('connection closed');
			})
			.mockImplementationOnce(async (request) => {
				requests.push(request);
				return { success: true, status: 'duplicate' };
			});
		const createId = vi.fn().mockReturnValueOnce('request-1').mockReturnValueOnce('message-1');
		const service = new AcceptedInputSubmissionService(transport({ run }), createId);

		const submission = service.run({
			chatId: 'chat-1',
			command: 'hello',
			permissionMode: 'default',
			thinkingMode: 'none',
			agentSettings: { ownerId: 'direct', schemaVersion: 1, values: {} },
			model: 'model-1',
		});

		expect(submission.clientRequestId).toBe('request-1');
		expect(submission.clientMessageId).toBe('message-1');
		await expect(submission.submit()).resolves.toMatchObject({ status: 'duplicate' });
		expect(requests).toHaveLength(2);
		expect(requests[0]).toBe(requests[1]);
		expect(requests[0]).toMatchObject({
			clientRequestId: 'request-1',
			clientMessageId: 'message-1',
		});
		expect(createId).toHaveBeenCalledTimes(2);
	});

	it('uses one identity for queued and goal-control submissions', async () => {
		const enqueue = vi.fn().mockResolvedValue({ success: true, status: 'accepted' });
		const goalControl = vi.fn().mockResolvedValue({ success: true, status: 'accepted' });
		const createId = vi.fn().mockReturnValueOnce('queue-1').mockReturnValueOnce('goal-1');
		const service = new AcceptedInputSubmissionService(
			transport({ enqueue, goalControl }),
			createId,
		);

		const queued = service.enqueue({ chatId: 'chat-1', content: 'later' });
		const goal = service.goalControl({ chatId: 'chat-1', content: '/goal pause' });
		await queued.submit();
		await goal.submit();

		expect(queued).toMatchObject({ clientRequestId: 'queue-1' });
		expect(goal).toMatchObject({ clientRequestId: 'goal-1' });
		expect(enqueue).toHaveBeenCalledWith({
			chatId: 'chat-1',
			content: 'later',
			clientRequestId: 'queue-1',
		});
		expect(goalControl).toHaveBeenCalledWith({
			chatId: 'chat-1',
			content: '/goal pause',
			clientRequestId: 'goal-1',
		});
	});

	it('creates both steering identities before submission', async () => {
		const steer = vi.fn().mockResolvedValue({ success: true, status: 'accepted' });
		const createId = vi.fn().mockReturnValueOnce('request-1').mockReturnValueOnce('message-1');
		const service = new AcceptedInputSubmissionService(transport({ steer }), createId);

		const submission = service.steer({ chatId: 'chat-1', content: 'focus here' });

		expect(submission).toMatchObject({
			clientRequestId: 'request-1',
			clientMessageId: 'message-1',
		});
		await submission.submit();
		expect(steer).toHaveBeenCalledWith({
			chatId: 'chat-1',
			content: 'focus here',
			clientRequestId: 'request-1',
			clientMessageId: 'message-1',
		});
	});
});
