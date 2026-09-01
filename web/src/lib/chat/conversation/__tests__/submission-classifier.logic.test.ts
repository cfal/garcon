import { describe, expect, it } from 'vitest';
import { emptyChatExecutionControlState } from '$shared/chat-execution-control';
import {
	classifySubmission,
	requiresQueuedSubmission,
	type SubmissionClassificationInput,
} from '../submission-classifier.js';

function input(
	overrides: Partial<SubmissionClassificationInput> = {},
): SubmissionClassificationInput {
	return {
		isDraft: false,
		isProcessing: false,
		handoffPending: false,
		control: emptyChatExecutionControlState('server-instance-test'),
		hasAttachments: false,
		...overrides,
	};
}

describe('classifySubmission', () => {
	it.each([
		['draft chat', input({ isDraft: true }), 'draft'],
		['idle chat', input(), 'direct'],
		['ordinary active-turn input', input({ isProcessing: true }), 'queue'],
		[
			'pending handoff during an active turn',
			input({ isProcessing: true, handoffPending: true }),
			'handoff-requires-idle',
		],
		[
			'queued predecessor',
			input({
				control: {
					...emptyChatExecutionControlState('server-instance-test'),
					queue: {
						...emptyChatExecutionControlState('server-instance-test').queue,
						entries: [
							{
								id: 'entry-1',
								content: 'first',
								revision: 1,
								createdAt: '2026-07-19T00:00:00.000Z',
								updatedAt: '2026-07-19T00:00:00.000Z',
							},
						],
					},
				},
			}),
			'queue',
		],
		[
			'paused queue',
			input({
				control: {
					...emptyChatExecutionControlState('server-instance-test'),
					queue: {
						...emptyChatExecutionControlState('server-instance-test').queue,
						pause: {
							id: 'pause-1',
							kind: 'manual',
							pausedAt: '2026-07-19T00:00:00.000Z',
						},
					},
				},
			}),
			'queue',
		],
		[
			'attachments requiring queue',
			input({ isProcessing: true, hasAttachments: true }),
			'queue-attachments-unsupported',
		],
		[
			'pending handoff behind a queued predecessor',
			input({
				handoffPending: true,
				control: {
					...emptyChatExecutionControlState('server-instance-test'),
					queue: {
						...emptyChatExecutionControlState('server-instance-test').queue,
						entries: [
							{
								id: 'entry-1',
								content: 'first',
								revision: 1,
								createdAt: '2026-07-19T00:00:00.000Z',
								updatedAt: '2026-07-19T00:00:00.000Z',
							},
						],
					},
				},
			}),
			'handoff-requires-idle',
		],
	] as const)('routes %s', (_name, classification, expected) => {
		expect(classifySubmission(classification)).toBe(expected);
	});
});

describe('requiresQueuedSubmission', () => {
	it.each([
		['processing chat', input({ isProcessing: true }), true],
		[
			'nonempty queue',
			input({
				control: {
					...emptyChatExecutionControlState('server-instance-test'),
					queue: {
						...emptyChatExecutionControlState('server-instance-test').queue,
						entries: [
							{
								id: 'entry-1',
								content: 'first',
								revision: 1,
								createdAt: '2026-07-19T00:00:00.000Z',
								updatedAt: '2026-07-19T00:00:00.000Z',
							},
						],
					},
				},
			}),
			true,
		],
		[
			'paused queue',
			input({
				control: {
					...emptyChatExecutionControlState('server-instance-test'),
					queue: {
						...emptyChatExecutionControlState('server-instance-test').queue,
						pause: {
							id: 'pause-1',
							kind: 'manual',
							pausedAt: '2026-07-19T00:00:00.000Z',
						},
					},
				},
			}),
			true,
		],
		['idle chat', input(), false],
	] as const)('identifies %s', (_name, classification, expected) => {
		expect(requiresQueuedSubmission(classification)).toBe(expected);
	});
});
