import { describe, expect, it } from 'bun:test';
import { AssistantMessage, UserMessage } from '../../../common/chat-types.ts';
import {
  createNativeSeedReceipt,
  renderCarriedContext,
} from '../../../common/transcript-seed.ts';
import { createPreamblePrefix } from '../../../common/preamble-prefix.ts';
import { importNativeHistoryDrafts } from '../native-history-seed.ts';

const AT = '2026-08-15T00:00:00.000Z';
const SESSION_ID = 'native-session-1';

describe('native history ledger seed', () => {
  it('strips the exact carried-context prefix without shifting provider metadata', async () => {
    const prefix = carriedContextPrefix();
    const receipt = createNativeSeedReceipt({
      agentSessionId: SESSION_ID,
      placement: 'user-prefix',
      prefix,
    });
    const recordedInput = new UserMessage(AT, `${prefix}continue from native history`);
    const recordedAnswer = new AssistantMessage(AT, 'native answer');
    let importedChat = null;

    const drafts = await importNativeHistoryDrafts(seedInput({
      receipt,
      async *load(request) {
        importedChat = request.chat;
        yield [
          { message: recordedInput, providerMeta: { nativeItemId: 'input-item' } },
          { message: recordedAnswer, providerMeta: { nativeItemId: 'answer-item' } },
        ];
      },
    }));

    expect(importedChat).toMatchObject({
      agentSessionId: SESSION_ID,
      nativeSeedReceipt: receipt,
    });
    expect(recordedInput.content).toBe(`${prefix}continue from native history`);
    expect(drafts).toMatchObject([
      {
        kind: 'user-input',
        detail: {
          clientMessageId: null,
          message: { type: 'user-message', content: 'continue from native history' },
        },
        providerMeta: { nativeItemId: 'input-item' },
      },
      {
        kind: 'provider-row',
        message: { type: 'assistant-message', content: 'native answer' },
        providerMeta: { nativeItemId: 'answer-item' },
      },
    ]);
  });

  it('[TLV5-ADOPT.08-NATIVE-SEED-SANITATION-UNIT-01] rejects a rewritten carried-context prefix before creating ledger drafts', async () => {
    const prefix = carriedContextPrefix();
    const receipt = createNativeSeedReceipt({
      agentSessionId: SESSION_ID,
      placement: 'user-prefix',
      prefix,
    });
    const rewrittenPrefix = prefix.replace('prior question', 'rewritten question');

    await expect(importNativeHistoryDrafts(seedInput({
      receipt,
      async *load() {
        yield [{
          message: new UserMessage(AT, `${rewrittenPrefix}continue from native history`),
          providerMeta: { nativeItemId: 'rewritten-input' },
        }];
      },
    }))).rejects.toMatchObject({
      code: 'CONTEXT_ENVELOPE_MISMATCH',
      retryable: false,
    });
  });

  it('strips carried context before reconstructing an exact preamble application', async () => {
    const carriedPrefix = carriedContextPrefix();
    const receipt = createNativeSeedReceipt({
      agentSessionId: SESSION_ID,
      placement: 'user-prefix',
      prefix: carriedPrefix,
    });
    const application = createPreamblePrefix({
      contents: ['private preamble body'],
    });
    const boundary = { kind: 'new-chat', ownershipEpoch: 'ownership-1' };

    const drafts = await importNativeHistoryDrafts(seedInput({
      receipt,
      preambleEvidence: [{
        receipt: application.receipt,
        boundary,
        preambles: [{ id: 'preamble-1', title: 'Repository rules' }],
        requiresNativeOccurrence: false,
      }],
      async *load() {
        yield [{
          message: new UserMessage(
            AT,
            `${carriedPrefix}${application.prefix}visible prompt`,
          ),
          providerMeta: { nativeItemId: 'prefixed-input' },
        }];
      },
    }));

    expect(drafts).toMatchObject([
      {
        kind: 'notice',
        message: 'Preambles applied',
        detail: {
          type: 'preamble-application',
          preambles: [{ id: 'preamble-1', title: 'Repository rules' }],
        },
      },
      {
        kind: 'user-input',
        detail: {
          message: { content: 'visible prompt' },
          preambleBoundary: boundary,
          preamblePrefixReceipt: application.receipt,
        },
        providerMeta: { nativeItemId: 'prefixed-input' },
      },
    ]);
    expect(JSON.stringify(drafts)).not.toContain('private preamble body');
  });

  it('allows receipt-bearing ledger evidence absent from native history after a pre-dispatch crash', async () => {
    const application = createPreamblePrefix({
      contents: ['private preamble body'],
    });
    const preambleEvidence = [{
      receipt: application.receipt,
      boundary: { kind: 'fork', ownershipEpoch: 'ownership-1' },
      preambles: [{ id: 'preamble-1', title: 'Repository rules' }],
      requiresNativeOccurrence: false,
    }];

    await expect(importNativeHistoryDrafts(seedInput({
      receipt: null,
      preambleEvidence,
      async *load() {
        yield [{ message: new UserMessage(AT, 'visible prompt') }];
      },
    }))).resolves.toMatchObject([{
      kind: 'user-input',
      detail: {
        message: { content: 'visible prompt' },
        preambleBoundary: null,
        preamblePrefixReceipt: null,
      },
    }]);
  });

  it('retries when native history omits a completed preamble application turn', async () => {
    const application = createPreamblePrefix({
      contents: ['private preamble body'],
    });

    await expect(importNativeHistoryDrafts(seedInput({
      receipt: null,
      preambleEvidence: [{
        receipt: application.receipt,
        boundary: { kind: 'new-chat', ownershipEpoch: 'ownership-1' },
        preambles: [{ id: 'preamble-1', title: 'Repository rules' }],
        requiresNativeOccurrence: true,
      }],
      async *load() {
        yield [{ message: new UserMessage(AT, 'earlier visible prompt') }];
      },
    }))).rejects.toMatchObject({
      code: 'HISTORY_LOAD_FAILED',
      retryable: true,
    });
  });

  it('fails closed when a receipt-bearing native prefix was changed', async () => {
    const application = createPreamblePrefix({
      contents: ['private preamble body'],
    });
    const preambleEvidence = [{
      receipt: application.receipt,
      boundary: { kind: 'fork', ownershipEpoch: 'ownership-1' },
      preambles: [{ id: 'preamble-1', title: 'Repository rules' }],
      requiresNativeOccurrence: false,
    }];

    await expect(importNativeHistoryDrafts(seedInput({
      receipt: null,
      preambleEvidence,
      async *load() {
        yield [{
          message: new UserMessage(
            AT,
            `${application.prefix.replace('private preamble body', 'changed preamble body')}visible prompt`,
          ),
        }];
      },
    }))).rejects.toMatchObject({ code: 'PREAMBLE_ENVELOPE_MISMATCH' });
  });
});

function carriedContextPrefix() {
  const context = renderCarriedContext([new UserMessage(AT, 'prior question')]);
  if (!context) throw new Error('The carried-context fixture did not render.');
  return context.prefix;
}

function seedInput({ receipt, load, preambleEvidence = [] }) {
  const settings = { ownerId: 'test', schemaVersion: 1, values: {} };
  return {
    chatId: 'chat-1',
    entry: {
      agentId: 'test',
      agentSessionId: SESSION_ID,
      nativeSession: { ownerId: 'test', schemaVersion: 1, value: { id: SESSION_ID } },
      nativeSeedReceipt: receipt,
      projectPath: '/tmp/project',
      model: 'test-model',
      agentSettingsById: { test: settings },
    },
    integration: {
      descriptor: { id: 'test' },
      settings: {
        defaults: () => settings,
        parse: (value) => value,
      },
    },
    nativeHistoryImport: { load },
    session: {
      agentSessionId: SESSION_ID,
      nativeSession: { ownerId: 'test', schemaVersion: 1, value: { id: SESSION_ID } },
      nativeSeedReceipt: receipt,
    },
    carryOverRevision: 'carryover-1',
    preambleEvidence,
    signal: new AbortController().signal,
    now: () => AT,
  };
}
