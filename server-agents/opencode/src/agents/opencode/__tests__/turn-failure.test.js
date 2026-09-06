import { expect, it } from 'bun:test';
import { getNativeMessageSource } from '@garcon/server-agent-common/shared/native-message-source';
import {
  latestOpenCodePromptTerminal,
  openCodeProviderFailureRow,
} from '../turn-failure.js';

it('excludes automatic compaction summaries from failure attribution', () => {
  const visibleTerminal = {
    outcome: 'failed',
    messageId: 'assistant-visible',
    error: 'visible failure',
  };
  const turn = {
    assistantMessageIds: new Set(['assistant-visible', 'assistant-summary']),
    automaticCompactionMessageIds: new Set(['assistant-summary']),
    assistantTerminals: new Map([
      ['assistant-visible', visibleTerminal],
      ['assistant-summary', {
        outcome: 'failed',
        messageId: 'assistant-summary',
        error: 'internal failure',
      }],
    ]),
  };

  expect(latestOpenCodePromptTerminal(turn)).toBe(visibleTerminal);
  expect(getNativeMessageSource(
    openCodeProviderFailureRow('control failure', undefined, turn),
  )).toEqual({
    entryId: 'assistant-visible',
  });
});
