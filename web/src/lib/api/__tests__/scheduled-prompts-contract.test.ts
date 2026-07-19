import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduleChatPrompt } from '../scheduled-prompts';
import { normalizeScheduledPromptTarget } from '$shared/scheduled-prompts';

vi.stubGlobal('localStorage', {
	getItem: () => 'test-token',
	setItem: () => {},
	removeItem: () => {},
});

const scheduledPrompt = {
	id: 'prompt-in',
	schedule: { type: 'once' as const, nextRunAt: '2030-01-01T09:00:00.000Z' },
	target: {
		type: 'existing-chat' as const,
		chatId: '123',
		busyBehavior: 'skip' as const,
	},
	prompt: 'Continue the work',
	createdAt: '2029-01-01T00:00:00.000Z',
	updatedAt: '2029-01-01T00:00:00.000Z',
};

describe('scheduled prompts API contract', () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('posts a relative scheduled prompt and normalizes the created prompt and snapshot', async () => {
		fetchMock.mockResolvedValue(
			Response.json({
				success: true,
				scheduledPrompt,
				snapshot: { revision: 1, prompts: [scheduledPrompt], runLog: [] },
			}),
		);

		const result = await scheduleChatPrompt({
			chatId: '123',
			duration: '2h30m',
			prompt: 'Continue the work',
		});

		expect(result.scheduledPrompt).toMatchObject(scheduledPrompt);
		const [url, options] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/v1/scheduled-prompts/in');
		expect(options.method).toBe('POST');
		expect(options.headers.Authorization).toBe('Bearer test-token');
		expect(JSON.parse(options.body)).toEqual({
			chatId: '123',
			duration: '2h30m',
			prompt: 'Continue the work',
		});
	});

	it('rejects malformed responses and snapshots that omit the scheduled prompt', async () => {
		fetchMock.mockResolvedValueOnce(
			Response.json({
				success: true,
				scheduledPrompt: { ...scheduledPrompt, schedule: { type: 'once', nextRunAt: 'invalid' } },
				snapshot: { revision: 1, prompts: [scheduledPrompt], runLog: [] },
			}),
		);
		await expect(
			scheduleChatPrompt({ chatId: '123', duration: '1m', prompt: 'Continue' }),
		).rejects.toThrow('Invalid schedule-in response');

		fetchMock.mockResolvedValueOnce(
			Response.json({
				success: true,
				scheduledPrompt,
				snapshot: { revision: 1, prompts: [], runLog: [] },
			}),
		);
		await expect(
			scheduleChatPrompt({ chatId: '123', duration: '1m', prompt: 'Continue' }),
		).rejects.toThrow('omitted the created prompt');
	});

	it('preserves typed API errors', async () => {
		fetchMock.mockResolvedValue(
			Response.json(
				{
					success: false,
					error: 'Seconds are not supported',
					errorCode: 'SCHEDULE_IN_SUB_MINUTE_UNSUPPORTED',
					retryable: false,
				},
				{ status: 400 },
			),
		);

		await expect(
			scheduleChatPrompt({ chatId: '123', duration: '10s', prompt: 'Continue' }),
		).rejects.toMatchObject({
			status: 400,
			errorCode: 'SCHEDULE_IN_SUB_MINUTE_UNSUPPORTED',
			retryable: false,
		});
	});
});

describe('scheduled new-chat target normalization', () => {
	const target = {
		type: 'new-chat',
		agentId: 'codex',
		projectPath: '/workspace/project',
		model: 'gpt-5',
		apiProviderId: null,
		modelEndpointId: null,
		modelProtocol: null,
		permissionMode: 'acceptEdits',
		thinkingMode: 'high',
		agentSettingsById: {
			codex: { ownerId: 'codex', schemaVersion: 1, values: {} },
		},
	};

	it('normalizes tags and defaults legacy targets to an empty list', () => {
		expect(normalizeScheduledPromptTarget(target)).toMatchObject({ tags: [] });
		expect(
			normalizeScheduledPromptTarget({
				...target,
				tags: ['Review Needed', 'review-needed', ' QA ', 42, '!!!'],
			}),
		).toMatchObject({ tags: ['qa', 'review-needed'] });
	});

	it('rejects a non-array tags field', () => {
		expect(normalizeScheduledPromptTarget({ ...target, tags: 'review' })).toBeNull();
	});
});
