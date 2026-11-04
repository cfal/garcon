import { expect, test } from 'bun:test';
import { AssistantMessage, BashToolUseMessage, PermissionRequestMessage, ThinkingMessage, ToolResultMessage,
  UserMessage, isToolUseMessage, parseChatMessage, type ChatMessage } from '../../../../common/chat-types.js';
import { HIDEABLE_TOOL_GROUPS, SUMMARY_CATEGORIES, TOOL_STRUCTURE, toolSummaryCategory, toolSummaryWeight, type SummaryCategory } from '../../../../common/transcript-display-policy.js';
import { compileHiddenBashCommandPatterns } from '../../../../common/transcript-display-matcher.js';
import type { DisplayProfile } from '../../../../common/transcript-display-contract.js';
import { buildConversationFeedRenderModel, conversationFeedItemLayout, filterHiddenToolRenderItems } from '../../../../web/src/lib/chat/transcript/__tests__/reference/conversation-feed-items.js';
import { buildConversationVirtualFeedModel } from '../../../../web/src/lib/chat/transcript/__tests__/reference/conversation-feed-virtual-items.js';
import { encodeLedgerDraft } from '../../ledger/codec.js';
import { DisplayStore } from '../store.js';
import { appendDisplayFrame } from '../extractor.js';
import { prepareBashFrame } from '../bash-revision.js';
import { DisplayQuery } from '../query.js';

const at = '2026-01-01T00:00:00.000Z';
test('all 512 local profiles preserve full-prefix layout and filtered adjacency', () => {
  const messages: ChatMessage[] = [new UserMessage(at, 'Generic prompt')];
  for (const type of Object.keys(TOOL_STRUCTURE)) {
    if (type === 'default') continue;
    const tool = parseChatMessage({ type, timestamp: at, toolId: `tool-${type}`, command: 'synthetic-command', path: '/generic/file',
      filePath: '/generic/file', pattern: '*', code: 'true', language: 'javascript', executionId: 'execution', query: 'generic', url: 'https://example.test',
      plan: 'Generic plan', description: 'Generic description', content: 'Synthetic content', action: 'spawn_agent', details: { taskName: 'worker' } });
    if (!tool || !isToolUseMessage(tool)) throw new Error(`Missing fixture for ${type}`);
    if (tool.type === 'ask-user-question-tool-use') messages.push(new PermissionRequestMessage(at, 'question-occurrence', tool));
    messages.push(tool, new ToolResultMessage(at, tool.toolId, { output: 'Generic result' }));
  }
  messages.push(new ThinkingMessage(at, 'Generic reasoning'), new BashToolUseMessage(at, 'empty-command', ''),
    new ToolResultMessage(at, 'empty-command', { output: 'Generic failure' }, true), new AssistantMessage(at, 'Generic answer'));
  const rows = messages.map((message, i) => {
    const draft = { kind: 'provider-row' as const, at, message }, encoded = encodeLedgerDraft(draft);
    return { view_id: 'view', ordinal: i + 1, kind: draft.kind, at, client_message_id: null, payload_json: encoded.payloadJson };
  });
  const store = new DisplayStore(':memory:');
  try {
    store.initialize('chat', 'view', 'server');
    for (const row of rows) appendDisplayFrame(store, [row], rows.length, 'server');
    const projected = buildConversationFeedRenderModel(messages.map((message, i) => ({ kind: 'message', id: `row-${i + 1}`, ordinal: i + 1, message })));
    for (const patterns of [[], [{ mode: 'regex' as const, pattern: '^$|synthetic' }]]) {
      const revision = patterns.length ? 'filtered' : 'empty';
      if (patterns.length) while (prepareBashFrame(store, revision, patterns, rows.length) < rows.length) {}
      for (let mask = 0; mask < 128; mask++) for (const combine of [false, true]) for (const showThinking of [false, true]) {
        const hidden = HIDEABLE_TOOL_GROUPS.filter((_, index) => mask & (1 << index));
        const profile: DisplayProfile = { combine, showThinking, hiddenToolGroups: hidden.map(group => group.id), bashRevision: revision };
        const visible = filterHiddenToolRenderItems(projected.items, hidden.flatMap(group => [...group.toolTypes]), compileHiddenBashCommandPatterns(patterns))
          .filter(item => conversationFeedItemLayout(item) !== 'hidden' && (showThinking || item.kind !== 'message' || item.message.type !== 'thinking'));
        const expected = buildConversationVirtualFeedModel({ showRefreshError: false, earlierBoundary: 'hidden', showLaterBoundary: false,
          reserveComposerCapSpace: false, surfaceIdentity: 'surface', transcriptItems: visible, transcriptViewId: 'view', pendingPermissions: [],
          combineToolUseMessages: combine, expandedToolMemberIds: new Set(), protectedVirtualKeys: [] }).items.flatMap(item => {
            if (item.kind === 'transcript') return [{ kind: 'row', ordinal: item.item.kind === 'message' ? item.item.ordinal : 0 }];
            if (item.kind !== 'tool-group') return [];
            const totals = Object.fromEntries(SUMMARY_CATEGORIES.map(category => [category, 0])) as Record<SummaryCategory, number>;
            const categoryOrder: SummaryCategory[] = [];
            for (const member of item.members) {
              if (member.item.kind !== 'message' || !isToolUseMessage(member.item.message)) throw new Error('Invalid reference member');
              const category = toolSummaryCategory(member.item.message.type);
              if (!categoryOrder.includes(category)) categoryOrder.push(category);
              totals[category] += toolSummaryWeight(member.item.message);
            }
            return [{ kind: 'tool-group', firstMember: item.members[0].item.kind === 'message' ? item.members[0].item.ordinal : 0,
              lastMember: item.members.at(-1)!.item.kind === 'message' ? item.members.at(-1)!.item.ordinal : 0,
              count: item.members.length, totals, categoryOrder }];
          });
        const actual = new DisplayQuery(store, profile, rows.length, [], patterns.length > 0).page(0, rows.length, false, 200)
          .map(item => item.kind === 'row' ? { kind: item.kind, ordinal: item.ordinal }
            : { kind: item.kind, firstMember: item.firstMember, lastMember: item.lastMember, count: item.count, totals: item.totals, categoryOrder: item.categoryOrder });
        expect(actual).toEqual(expected);
      }
    }
  } finally { store.close(); }
});
