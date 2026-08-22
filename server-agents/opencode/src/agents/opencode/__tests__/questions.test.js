import { describe, expect, it } from 'bun:test';
import {
  extractOpenCodeQuestionRequest,
  mapOpenCodeQuestionDecision,
} from '../questions.js';

const QUESTIONS = [
  {
    id: 'Which mode?',
    prompt: 'Which mode?',
    options: [
      { id: 'Fast', label: 'Fast' },
      { id: 'Careful', label: 'Careful' },
    ],
    allowMultiple: false,
  },
  {
    id: 'Which checks?',
    prompt: 'Which checks?',
    options: [
      { id: 'Unit', label: 'Unit tests' },
      { id: 'Integration', label: 'Integration tests' },
    ],
    allowMultiple: true,
  },
];

describe('OpenCode questions', () => {
  it('extracts the routed provider request fields', () => {
    expect(extractOpenCodeQuestionRequest({
      type: 'question.asked',
      properties: {
        id: 'provider-request',
        sessionID: 'session-a',
        questions: [{ question: 'Which mode?', header: 'Mode', options: [] }],
        tool: { callID: 'call-question', messageID: 'assistant-a' },
      },
    })).toEqual({
      requestId: 'provider-request',
      toolCallId: 'call-question',
      questions: [{ question: 'Which mode?', header: 'Mode', options: [] }],
    });
  });

  it.each([
    { type: 'message.updated', properties: {} },
    { type: 'question.asked', properties: { questions: [], tool: { callID: 'call' } } },
    { type: 'question.asked', properties: { id: 'request', questions: {}, tool: { callID: 'call' } } },
    { type: 'question.asked', properties: { id: 'request', questions: [], tool: {} } },
  ])('rejects malformed question events', (event) => {
    expect(extractOpenCodeQuestionRequest(event)).toBeNull();
  });

  it('maps selected option identities to ordered OpenCode answer labels', () => {
    expect(mapOpenCodeQuestionDecision(QUESTIONS, {
      allow: true,
      response: {
        type: 'ask-user-question-response',
        outcome: 'answered',
        answers: [
          { questionId: 'Which checks?', selectedOptionIds: ['Unit', 'Integration'] },
          { questionId: 'Which mode?', selectedOptionIds: ['Careful'] },
        ],
      },
    })).toEqual({
      kind: 'reply',
      answers: [['Careful'], ['Unit tests', 'Integration tests']],
    });
  });

  it.each([
    { allow: false },
    {
      allow: true,
      response: {
        type: 'ask-user-question-response',
        outcome: 'skipped',
        reason: 'User skipped question',
      },
    },
  ])('maps denial and Skip to rejection', (decision) => {
    expect(mapOpenCodeQuestionDecision(QUESTIONS, decision)).toEqual({ kind: 'reject' });
  });

  it('refuses an allow decision without canonical question answers', () => {
    expect(() => mapOpenCodeQuestionDecision(QUESTIONS, { allow: true }))
      .toThrow('missing an answered response');
  });
});
