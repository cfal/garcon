import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { appendFile, chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, CDPSession, Page } from 'playwright';
import {
  AssistantMessage,
  BashToolUseMessage,
  CompactionMessage,
  ToolResultMessage,
  UserMessage,
  WebSearchToolUseMessage,
  type ChatMessage,
} from '../../../common/chat-types.js';
import type { TranscriptMessage } from '../../../common/chat-view.js';
import type { LedgerRowDraft } from '../../../server/ledger/contracts.js';
import { TranscriptLedgerStore } from '../../../server/ledger/store.js';
import type { IntegrationFixture } from '../../support/integration-fixture.js';
import {
  closeChromiumBrowser,
  launchChromiumBrowser,
  withChromiumFixture,
  type ChromiumFixture,
} from '../../support/chromium-fixture.js';
import { claudeText, claudeToolUse } from '../../support/fake-claude-model.js';
import {
  CLAUDE_BINARY,
  liveClaudeRunRequest,
  liveClaudeStartRequest,
} from '../../support/live-claude.js';
import {
  startScriptedClaudeTestEnvironment,
  type ScriptedClaudeTestEnvironment,
} from '../../support/scripted-claude.js';
import { waitForPersistedNativeSession } from '../../support/persisted-chat.js';

const FEED_SELECTOR = '[data-chat-scroll-viewport]';
const SIZER_SELECTOR = '[data-chat-virtual-sizer]';
const ITEM_SELECTOR = '[data-chat-virtual-item]';
const RETIRED_LIVE_EDGE_PRUNE_INTERVAL_MS = 180_000;
const REUSED_PERMISSION_CLAUDE_PROXY = fileURLToPath(
  new URL('../../support/reused-permission-claude-proxy.ts', import.meta.url),
);
const PERMISSION_OCCURRENCE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRANSCRIPT_VIEWPORTS = [
  { label: 'compact', height: 700, width: 390 },
  { label: 'wide', height: 900, width: 1280 },
] as const;

interface ReadingAnchor {
  key: string;
  offset: number;
  rowId?: string;
  text?: string;
}

interface ReadingAnchorFrameSample {
  busy: boolean;
  connected: boolean;
  frame: number;
  mountedKeys: string[];
  offset: number | null;
  pinned: boolean;
  rowId: string | null;
  sameNode: boolean;
  scrollTop: number;
  text: string | null;
}

interface TranscriptTouchDrag {
  session: CDPSession;
  identifier: number;
  maximumY: number;
  x: number;
  y: number;
}

interface TranscriptScrollTopWrite {
  duringCoasting: boolean;
  value: number;
}

interface TouchPrependScenario {
  caseId: string;
  clampBeforeRelease: boolean;
  label: string;
  liveBehavior: 'completed' | 'expanding' | 'paused-interrupted';
  viewport: { height: number; width: number };
}

interface SelectionSnapshot {
  key: string;
  rowId: string;
  text: string;
  scrollTarget: 'start' | 'end';
}

interface TranscriptGeometry {
  distanceFromEnd: number;
  itemCount: number;
  transcriptItemCount: number;
  modelCount: number;
  overlaps: Array<{ previous: string; next: string; amount: number }>;
  horizontalOverflow: Array<{ key: string; left: number; right: number }>;
}

interface TranscriptRowObservation {
  bashCommand: {
    buttonCount: number;
    tagName: string;
    text: string;
  } | null;
  itemIndex: number;
  messageType: string;
  rowId: string;
  text: string;
}

interface ExactTranscriptRow {
  ordinal: number;
  type: ChatMessage['type'];
  text: string;
}

interface TranscriptViewportScan {
  duplicateMountedRowIds: string[];
  indexChanges: Array<{ rowId: string; previous: number; current: number }>;
  rows: TranscriptRowObservation[];
  visualOrderViolations: Array<{ previous: string; next: string }>;
}

interface TranscriptLayoutSnapshot {
  anchor: ReadingAnchor;
  anchorTransform: string;
  feed: {
    top: number;
    height: number;
    scrollTop: number;
    scrollHeight: number;
  };
  sizer: {
    top: number;
    height: number;
    declaredHeight: string;
    scale: string | undefined;
  };
  workspace: {
    top: number;
    height: number;
    styleTop: string;
    styleHeight: string;
  } | null;
}

async function withDiagnosticTimeout<T>(
  description: string,
  operation: Promise<T>,
  timeoutMs = 20_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}.`)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function appendTurn(
  integration: IntegrationFixture,
  chatId: string,
  content: string,
): Promise<void> {
  const accepted = await integration.client.runDirectChat({
    chatId,
    content,
    agent: integration.directAgents.openAi,
  });
  const terminal = await integration.client.waitForTurnTerminal(chatId, accepted.turnId);
  expect(terminal.type).toBe('agent-run-finished');
}

async function seedTranscript(
  integration: IntegrationFixture,
  turnCount: number,
  promptPrefix = 'chromium-virtual-turn',
): Promise<string> {
  const chatId = integration.newChatId();
  const started = await integration.client.startDirectChat({
    chatId,
    content: `${promptPrefix}-0`,
    projectPath: integration.dirs.project,
    agent: integration.directAgents.openAi,
  });
  expect((await integration.client.waitForTurnTerminal(chatId, started.turnId)).type).toBe(
    'agent-run-finished',
  );
  for (let index = 1; index < turnCount; index += 1) {
    await appendTurn(integration, chatId, `${promptPrefix}-${index}`);
  }
  return chatId;
}

function exactTranscriptText(message: ChatMessage): string {
  switch (message.type) {
    case 'user-message':
    case 'assistant-message':
      return message.content;
    case 'bash-tool-use':
      return `$ ${message.command}`;
    case 'tool-result':
      return typeof message.content.raw === 'string'
        ? message.content.raw
        : JSON.stringify(message.content);
    case 'compaction':
      return message.summary;
    default:
      throw new Error(`The exact transcript fixture does not support ${message.type}.`);
  }
}

function exactTranscriptRow(entry: TranscriptMessage): ExactTranscriptRow {
  return {
    ordinal: entry.ordinal,
    type: entry.message.type,
    text: exactTranscriptText(entry.message),
  };
}

function mixedOrderingRows(firstOrdinal: number): {
  drafts: LedgerRowDraft[];
  expected: ExactTranscriptRow[];
} {
  const drafts: LedgerRowDraft[] = [];
  const expected: ExactTranscriptRow[] = [];
  let ordinal = firstOrdinal;

  const addMessage = (message: ChatMessage, clientMessageId?: string): void => {
    const draft: LedgerRowDraft =
      message instanceof UserMessage
        ? {
            kind: 'user-input',
            at: message.timestamp,
            detail: {
              clientMessageId: clientMessageId ?? `mixed-client-${ordinal}`,
              message,
              attachments: [],
              steer: false,
            },
            providerMeta: null,
          }
        : {
            kind: 'provider-row',
            at: message.timestamp,
            message,
            providerMeta: null,
          };
    drafts.push(draft);
    expected.push({
      ordinal,
      type: message.type,
      text: exactTranscriptText(message),
    });
    ordinal += 1;
  };
  const timestamp = () => new Date(Date.UTC(2026, 7, 15) + ordinal).toISOString();

  for (let turn = 0; turn < 74; turn += 1) {
    addMessage(new UserMessage(timestamp(), `mixed-user-${turn}`));
    addMessage(new AssistantMessage(timestamp(), `mixed-assistant-${turn}`));
  }

  for (let commandIndex = 0; commandIndex < 30; commandIndex += 1) {
    const toolId = `mixed-bash-${commandIndex}`;
    addMessage(
      new BashToolUseMessage(timestamp(), toolId, `printf 'mixed-command-${commandIndex}\\n'`),
    );
    addMessage(
      new ToolResultMessage(timestamp(), toolId, { raw: `mixed-result-${commandIndex}` }, false),
    );
    if ((commandIndex + 1) % 5 === 0) {
      addMessage(
        new CompactionMessage(timestamp(), 'auto', `mixed-compaction-${(commandIndex + 1) / 5}`),
      );
      addMessage(new AssistantMessage(timestamp(), 'repeated-equal-assistant-content'));
    }
  }

  for (let turn = 74; turn < 84; turn += 1) {
    addMessage(new UserMessage(timestamp(), `mixed-user-${turn}`));
    addMessage(new AssistantMessage(timestamp(), `mixed-assistant-${turn}`));
  }

  addMessage(new CompactionMessage(timestamp(), 'manual', 'mixed-tail-compaction'));
  for (let commandIndex = 30; commandIndex < 42; commandIndex += 1) {
    const toolId = `mixed-bash-${commandIndex}`;
    addMessage(
      new BashToolUseMessage(timestamp(), toolId, `printf 'mixed-command-${commandIndex}\\n'`),
    );
    addMessage(
      new ToolResultMessage(timestamp(), toolId, { raw: `mixed-result-${commandIndex}` }, false),
    );
  }
  addMessage(new AssistantMessage(timestamp(), 'mixed-final-assistant-after-all-tools'));

  return { drafts, expected };
}

function crossPageToolPairRows(firstOrdinal: number): {
  drafts: LedgerRowDraft[];
  toolResultOrdinal: number;
  toolUseOrdinal: number;
} {
  const drafts: LedgerRowDraft[] = [];
  let ordinal = firstOrdinal;
  const add = (message: ChatMessage): number => {
    const messageOrdinal = ordinal;
    drafts.push({
      kind: 'provider-row',
      at: message.timestamp,
      message,
      providerMeta: null,
    });
    ordinal += 1;
    return messageOrdinal;
  };
  const timestamp = () => new Date(Date.UTC(2026, 7, 15) + ordinal).toISOString();

  for (let index = 0; index < 48; index += 1) {
    add(new AssistantMessage(timestamp(), `tool-boundary-before-${index}`));
  }
  const toolId = 'cross-page-web-search';
  const toolUseOrdinal = add(
    new WebSearchToolUseMessage(timestamp(), toolId, 'cross-page transcript stability'),
  );
  const toolResultOrdinal = add(
    new ToolResultMessage(timestamp(), toolId, { raw: 'cross-page-search-result' }, false),
  );
  for (let index = 0; index < 49; index += 1) {
    add(new AssistantMessage(timestamp(), `tool-boundary-after-${index}`));
  }
  return { drafts, toolResultOrdinal, toolUseOrdinal };
}

async function appendLedgerRows(
  fixture: ChromiumFixture,
  chatId: string,
  transcriptViewId: string,
  drafts: readonly LedgerRowDraft[],
): Promise<void> {
  await fixture.integration.restartGarcon({
    beforeStart: async () => {
      const store = new TranscriptLedgerStore(
        join(fixture.integration.dirs.workspace, 'transcript-ledgers'),
      );
      try {
        const view = store.currentView(chatId);
        if (view?.viewId !== transcriptViewId) {
          throw new Error('The mixed transcript fixture opened a different transcript view.');
        }
        store.append(chatId, view.viewId, drafts);
      } finally {
        store.close();
      }
    },
  });
}

async function selectSidebarChat(page: Page, chatId: string, marker: string): Promise<void> {
  const summary = page
    .locator('[data-slot="sidebar-chat-summary"]')
    .filter({ hasText: marker })
    .first();
  if (!(await summary.isVisible())) {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
  }
  await summary.waitFor({ state: 'visible' });
  await summary.locator('xpath=ancestor::button[1]').click();
  await page.waitForURL((url) => url.pathname === `/chat/${encodeURIComponent(chatId)}`);
  await waitForTranscriptReady(page);
}

async function waitForModelCount(page: Page, minimum: number): Promise<number> {
  await page.waitForFunction(
    ({ selector, minimumCount }) => {
      const sizer = document.querySelector<HTMLElement>(selector);
      return Number(sizer?.dataset.chatVirtualModelCount ?? 0) >= minimumCount;
    },
    { selector: SIZER_SELECTOR, minimumCount: minimum },
    { timeout: 20_000 },
  );
  return page
    .locator(SIZER_SELECTOR)
    .evaluate((sizer) => Number((sizer as HTMLElement).dataset.chatVirtualModelCount ?? 0));
}

async function waitForStableModelCount(page: Page, minimum: number): Promise<number> {
  await waitForModelCount(page, minimum);
  return page.locator(SIZER_SELECTOR).evaluate(async (sizerElement, minimumCount) => {
    const sizer = sizerElement as HTMLElement;
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    let previous = -1;
    let stableFrames = 0;
    for (let attempt = 0; attempt < 90; attempt += 1) {
      await frame();
      const current = Number(sizer.dataset.chatVirtualModelCount ?? 0);
      stableFrames = current >= minimumCount && current === previous ? stableFrames + 1 : 0;
      previous = current;
      if (stableFrames >= 12) return current;
    }
    throw new Error('The staged transcript model did not settle.');
  }, minimum);
}

interface TouchPublicationSnapshot {
  readonly busy: boolean;
  readonly dataRevision: number;
  readonly entryCount: number;
  readonly layoutPending: boolean;
  readonly modelCount: number;
}

async function touchPublicationSnapshot(page: Page): Promise<TouchPublicationSnapshot> {
  return page.locator(FEED_SELECTOR).evaluate((feedElement, sizerSelector) => {
    const feed = feedElement as HTMLElement;
    const sizer = document.querySelector<HTMLElement>(sizerSelector);
    if (!sizer) throw new Error('The transcript virtual sizer is missing.');
    return {
      busy: feed.getAttribute('aria-busy') !== 'false',
      dataRevision: Number(sizer.dataset.chatVirtualDataRevision ?? 0),
      entryCount: Number(sizer.dataset.chatTranscriptEntryCount ?? 0),
      layoutPending: feed.querySelector('[data-chat-layout-pending]') !== null,
      modelCount: Number(sizer.dataset.chatVirtualModelCount ?? 0),
    };
  }, SIZER_SELECTOR);
}

function publicationReady(
  snapshot: TouchPublicationSnapshot,
  baseline: TouchPublicationSnapshot,
  expectedEntryCount: number,
): boolean {
  return (
    snapshot.entryCount === expectedEntryCount &&
    snapshot.modelCount === baseline.modelCount + (expectedEntryCount - baseline.entryCount) &&
    snapshot.dataRevision > baseline.dataRevision &&
    !snapshot.busy &&
    !snapshot.layoutPending
  );
}

async function transcriptEntryCount(page: Page): Promise<number> {
  return page
    .locator(SIZER_SELECTOR)
    .evaluate((sizer) => Number((sizer as HTMLElement).dataset.chatTranscriptEntryCount ?? 0));
}

async function scanLoadedTranscript(page: Page): Promise<TranscriptViewportScan> {
  return page.locator(FEED_SELECTOR).evaluate(async (feedElement, itemSelector) => {
    const feed = feedElement as HTMLElement;
    const rows = new Map<string, TranscriptRowObservation>();
    const duplicateMountedRowIds = new Set<string>();
    const indexChanges: TranscriptViewportScan['indexChanges'] = [];
    const visualOrderViolations: TranscriptViewportScan['visualOrderViolations'] = [];
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const capture = () => {
      const mounted = [...feed.querySelectorAll<HTMLElement>(itemSelector)]
        .flatMap((item) => {
          const row = item.querySelector<HTMLElement>('[data-chat-row-id]');
          const itemIndex = Number(item.dataset.index);
          if (!row?.dataset.chatRowId || !Number.isFinite(itemIndex)) return [];
          const bashCommand = row.querySelector<HTMLElement>('[data-chat-bash-command]');
          return [
            {
              bashCommand: bashCommand
                ? {
                    buttonCount: row.querySelectorAll('button').length,
                    tagName: bashCommand.tagName,
                    text: bashCommand.innerText.trim(),
                  }
                : null,
              itemIndex,
              messageType: row.dataset.chatMessageType ?? '',
              rect: item.getBoundingClientRect(),
              rowId: row.dataset.chatRowId,
              text: row.innerText.trim(),
            },
          ];
        })
        .sort((left, right) => left.itemIndex - right.itemIndex);
      const mountedIds = new Set<string>();
      for (const row of mounted) {
        if (mountedIds.has(row.rowId)) duplicateMountedRowIds.add(row.rowId);
        mountedIds.add(row.rowId);
        const previous = rows.get(row.rowId);
        if (previous && previous.itemIndex !== row.itemIndex) {
          indexChanges.push({
            rowId: row.rowId,
            previous: previous.itemIndex,
            current: row.itemIndex,
          });
        }
        rows.set(row.rowId, {
          bashCommand: row.bashCommand,
          itemIndex: row.itemIndex,
          messageType: row.messageType,
          rowId: row.rowId,
          text: row.text,
        });
      }
      for (let index = 1; index < mounted.length; index += 1) {
        const previous = mounted[index - 1];
        const next = mounted[index];
        if (previous && next && next.rect.top < previous.rect.top) {
          visualOrderViolations.push({
            previous: previous.rowId,
            next: next.rowId,
          });
        }
      }
    };

    feed.scrollTop = 0;
    feed.dispatchEvent(new Event('scroll', { bubbles: true }));
    for (let settledFrame = 0; settledFrame < 4; settledFrame += 1) await frame();
    capture();

    for (let attempt = 0; attempt < 512; attempt += 1) {
      const maximum = Math.max(0, feed.scrollHeight - feed.clientHeight);
      if (feed.scrollTop >= maximum - 1) break;
      const previousTop = feed.scrollTop;
      feed.scrollTop = Math.min(maximum, previousTop + Math.max(1, feed.clientHeight * 0.6));
      feed.dispatchEvent(new Event('scroll', { bubbles: true }));
      await frame();
      await frame();
      capture();
      if (feed.scrollTop <= previousTop + 0.5) {
        throw new Error('The transcript viewport stopped before reaching its loaded later edge.');
      }
    }

    const maximum = Math.max(0, feed.scrollHeight - feed.clientHeight);
    if (feed.scrollTop < maximum - 1) {
      throw new Error('The transcript viewport scan exceeded its bounded iteration count.');
    }
    for (let settledFrame = 0; settledFrame < 4; settledFrame += 1) await frame();
    capture();

    return {
      duplicateMountedRowIds: [...duplicateMountedRowIds],
      indexChanges,
      rows: [...rows.values()].sort((left, right) => left.itemIndex - right.itemIndex),
      visualOrderViolations,
    };
  }, ITEM_SELECTOR);
}

async function waitForTranscriptEntryCount(page: Page, minimum: number): Promise<number> {
  await page.waitForFunction(
    ({ selector, minimumCount }) => {
      const sizer = document.querySelector<HTMLElement>(selector);
      return Number(sizer?.dataset.chatTranscriptEntryCount ?? 0) >= minimumCount;
    },
    { selector: SIZER_SELECTOR, minimumCount: minimum },
  );
  return transcriptEntryCount(page);
}

async function virtualDataRevision(page: Page): Promise<number> {
  return page
    .locator(SIZER_SELECTOR)
    .evaluate((sizer) => Number((sizer as HTMLElement).dataset.chatVirtualDataRevision ?? 0));
}

async function waitForVirtualDataRevisionAfter(page: Page, previous: number): Promise<void> {
  await page.waitForFunction(
    ({ selector, previousRevision }) =>
      Number(document.querySelector<HTMLElement>(selector)?.dataset.chatVirtualDataRevision ?? 0) >
      previousRevision,
    { selector: SIZER_SELECTOR, previousRevision: previous },
    { timeout: 20_000 },
  );
}

async function waitForDistanceFromEnd(page: Page, maximum: number): Promise<void> {
  await page.waitForFunction(
    ({ selector, maximumDistance }) => {
      const feed = document.querySelector<HTMLElement>(selector);
      return Boolean(
        feed && feed.scrollHeight - feed.clientHeight - feed.scrollTop <= maximumDistance,
      );
    },
    { selector: FEED_SELECTOR, maximumDistance: maximum },
    { timeout: 20_000 },
  );
}

async function waitForStablePinnedTranscriptLayout(
  page: Page,
  scenario = 'unnamed',
): Promise<void> {
  await withDiagnosticTimeout(
    `the pinned transcript geometry to settle (${scenario})`,
    page.locator(FEED_SELECTOR).evaluate(
      async (feedElement, input) => {
        const feed = feedElement as HTMLElement;
        const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        let previous: {
          dataRevision: number;
          distanceFromEnd: number;
          itemCount: number;
          lastBottom: number;
          lastHeight: number;
          lastKey: string;
          modelCount: number;
          scrollHeight: number;
          scrollTop: number;
        } | null = null;
        let stableFrames = 0;
        let diagnostic: unknown = null;

        for (let attempt = 0; attempt < 90; attempt += 1) {
          await frame();
          const sizer = feed.querySelector<HTMLElement>(input.sizerSelector);
          const items = [...feed.querySelectorAll<HTMLElement>(input.itemSelector)]
            .map((item) => ({
              index: Number(item.dataset.index),
              key: item.dataset.chatVirtualItem ?? '',
              rect: item.getBoundingClientRect(),
            }))
            .filter((item) => Number.isFinite(item.index))
            .sort((left, right) => left.index - right.index);
          const overlaps: Array<{
            previous: string;
            next: string;
            amount: number;
          }> = [];
          const discontinuities: Array<{
            previous: string;
            next: string;
            delta: number;
          }> = [];
          for (let index = 1; index < items.length; index += 1) {
            const prior = items[index - 1];
            const current = items[index];
            if (!prior || !current || current.index !== prior.index + 1) continue;
            const delta = current.rect.top - prior.rect.bottom;
            if (delta < -1) {
              overlaps.push({
                previous: prior.key,
                next: current.key,
                amount: -delta,
              });
            } else if (delta > 1) {
              discontinuities.push({
                previous: prior.key,
                next: current.key,
                delta,
              });
            }
          }
          const last = items.at(-1);
          const current = {
            dataRevision: Number(sizer?.dataset.chatVirtualDataRevision ?? 0),
            distanceFromEnd: feed.scrollHeight - feed.clientHeight - feed.scrollTop,
            itemCount: items.length,
            lastBottom: last?.rect.bottom ?? Number.NaN,
            lastHeight: last?.rect.height ?? Number.NaN,
            lastKey: last?.key ?? '',
            modelCount: Number(sizer?.dataset.chatVirtualModelCount ?? 0),
            scrollHeight: feed.scrollHeight,
            scrollTop: feed.scrollTop,
          };
          const ready =
            feed.getAttribute('aria-busy') === 'false' &&
            feed.dataset.chatPinnedToBottom === 'true' &&
            !feed.querySelector('[data-chat-layout-pending]') &&
            current.itemCount > 0 &&
            current.modelCount > 0 &&
            Math.abs(current.distanceFromEnd) <= 1 &&
            overlaps.length === 0 &&
            discontinuities.length === 0;
          const unchanged =
            previous !== null &&
            current.dataRevision === previous.dataRevision &&
            current.itemCount === previous.itemCount &&
            current.lastKey === previous.lastKey &&
            current.modelCount === previous.modelCount &&
            Math.abs(current.distanceFromEnd - previous.distanceFromEnd) <= 0.5 &&
            Math.abs(current.lastBottom - previous.lastBottom) <= 0.5 &&
            Math.abs(current.lastHeight - previous.lastHeight) <= 0.5 &&
            Math.abs(current.scrollHeight - previous.scrollHeight) <= 0.5 &&
            Math.abs(current.scrollTop - previous.scrollTop) <= 0.5;
          stableFrames = ready && unchanged ? stableFrames + 1 : 0;
          diagnostic = {
            current,
            discontinuities,
            overlaps,
            ready,
            stableFrames,
          };
          previous = current;
          if (stableFrames >= 7) return;
        }
        throw new Error(
          `Pinned transcript geometry did not settle (${input.scenario}): ${JSON.stringify(diagnostic)}`,
        );
      },
      { itemSelector: ITEM_SELECTOR, sizerSelector: SIZER_SELECTOR, scenario },
    ),
  );
}

async function waitForTranscriptReady(page: Page): Promise<void> {
  await page.locator(FEED_SELECTOR).waitFor({ state: 'visible' });
  await page.locator(`${FEED_SELECTOR}[aria-busy="false"]`).waitFor({ state: 'visible' });
}

async function surfaceIdentity(page: Page): Promise<string> {
  return page
    .locator(ITEM_SELECTOR)
    .first()
    .evaluate((item) => {
      const value = (item as HTMLElement).dataset.chatVirtualItem;
      if (!value) throw new Error('Virtual item key is missing.');
      const parsed = JSON.parse(value);
      if (!Array.isArray(parsed) || typeof parsed[0] !== 'string') {
        throw new Error('Virtual item key does not contain a surface identity.');
      }
      return parsed[0];
    });
}

async function waitForSurfaceIdentity(page: Page, expected: string): Promise<void> {
  await page.waitForFunction(
    ({ selector, expectedIdentity }) => {
      const identities = [...document.querySelectorAll<HTMLElement>(selector)].flatMap((item) => {
        const value = item.dataset.chatVirtualItem;
        if (!value) return [];
        try {
          const parsed = JSON.parse(value);
          return Array.isArray(parsed) && typeof parsed[0] === 'string' ? [parsed[0]] : [];
        } catch {
          return [];
        }
      });
      return identities.length > 0 && identities.every((identity) => identity === expectedIdentity);
    },
    { selector: ITEM_SELECTOR, expectedIdentity: expected },
    { timeout: 20_000 },
  );
}

async function synchronizeNativeTranscriptGeneration(
  fixture: ChromiumFixture,
  chatId: string,
): Promise<void> {
  const transcript = await fixture.integration.client.getMessages(chatId, {
    limit: 200,
  });
  expect(transcript.hasMore).toBe(false);
  await waitForSurfaceIdentity(fixture.page, `${chatId}:${transcript.transcriptViewId}`);
  await waitForTranscriptReady(fixture.page);
}

async function scrollToPosition(
  page: Page,
  position: 'start' | 'middle' | 'end',
  signalIntent = true,
): Promise<void> {
  await page.locator(FEED_SELECTOR).evaluate(
    async (feedElement, target) => {
      const feed = feedElement as HTMLElement;
      if (target.signalIntent) {
        const deltaY = target.position === 'start' || target.position === 'middle' ? -600 : 600;
        feed.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY }));
      }
      const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const attempts = target.position === 'middle' ? 1 : 16;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const maximum = Math.max(0, feed.scrollHeight - feed.clientHeight);
        feed.scrollTop =
          target.position === 'start' ? 0 : target.position === 'middle' ? maximum / 2 : maximum;
        feed.dispatchEvent(new Event('scroll', { bubbles: true }));
        await settle();
        await settle();
        if (target.position === 'middle') {
          let previous = feed.scrollTop;
          let stableFrames = 0;
          for (let frame = 0; frame < 16; frame += 1) {
            await settle();
            const current = feed.scrollTop;
            stableFrames = Math.abs(current - previous) <= 0.5 ? stableFrames + 1 : 0;
            previous = current;
            if (stableFrames >= 4) return;
          }
          throw new Error('Transcript middle position did not settle.');
        }
        const distanceFromTarget =
          target.position === 'start'
            ? feed.scrollTop
            : Math.abs(feed.scrollHeight - feed.clientHeight - feed.scrollTop);
        if (distanceFromTarget <= 1) {
          for (let stableFrame = 0; stableFrame < 4; stableFrame += 1) await settle();
          const settledDistance =
            target.position === 'start'
              ? feed.scrollTop
              : Math.abs(feed.scrollHeight - feed.clientHeight - feed.scrollTop);
          if (settledDistance <= 1) return;
        }
      }
      throw new Error(`Transcript did not settle at its ${target.position} position.`);
    },
    { position, signalIntent },
  );
}

async function signalScrollIntent(page: Page, direction: 'earlier' | 'later'): Promise<void> {
  await page.locator(FEED_SELECTOR).evaluate((feedElement, requestedDirection) => {
    feedElement.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        deltaY: requestedDirection === 'earlier' ? -1 : 1,
      }),
    );
  }, direction);
}

async function transcriptBoundaryIntersectsViewport(
  page: Page,
  direction: 'earlier' | 'later',
): Promise<boolean> {
  return page.locator(FEED_SELECTOR).evaluate((feedElement, requestedDirection) => {
    const boundary = feedElement.querySelector<HTMLElement>(
      `[data-transcript-page-boundary="${requestedDirection}"]`,
    );
    if (!boundary) return false;
    const viewportRect = feedElement.getBoundingClientRect();
    const boundaryRect = boundary.getBoundingClientRect();
    return boundaryRect.bottom > viewportRect.top && boundaryRect.top < viewportRect.bottom;
  }, direction);
}

async function selectVisibleMessageText(page: Page): Promise<SelectionSnapshot> {
  return page.locator(FEED_SELECTOR).evaluate((feedElement) => {
    const feed = feedElement as HTMLElement;
    const viewport = feed.getBoundingClientRect();
    const row = [...feed.querySelectorAll<HTMLElement>('[data-chat-row-id]')].find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return (
        rect.top >= viewport.top && rect.bottom <= viewport.bottom && candidate.textContent?.trim()
      );
    });
    if (!row) throw new Error('No fully visible transcript row was available for selection.');
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let textNode: Text | null = null;
    while (walker.nextNode()) {
      const candidate = walker.currentNode;
      if (candidate instanceof Text && candidate.data.trim().length >= 8) {
        textNode = candidate;
        break;
      }
    }
    if (!textNode) throw new Error('The selected transcript row had no usable text node.');
    const start = textNode.data.search(/\S/);
    const end = Math.min(textNode.length, start + 12);
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, end);
    const selection = document.getSelection();
    if (!selection) throw new Error('The browser selection API is unavailable.');
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    const wrapper = row.closest<HTMLElement>('[data-chat-virtual-item]');
    const key = wrapper?.dataset.chatVirtualItem;
    const rowId = row.dataset.chatRowId;
    if (!key || !rowId) throw new Error('The selected row is missing its virtual identity.');
    const maximum = Math.max(0, feed.scrollHeight - feed.clientHeight);
    return {
      key,
      rowId,
      text: selection.toString(),
      scrollTarget: feed.scrollTop < maximum / 2 ? 'end' : 'start',
    };
  });
}

async function releaseBrowserSelection(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
  });
}

async function verifyDetachedNearEndGrowth(page: Page): Promise<void> {
  await signalScrollIntent(page, 'earlier');
  await page.locator(FEED_SELECTOR).evaluate(async (feedElement) => {
    const feed = feedElement as HTMLElement;
    const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    feed.scrollTop = Math.max(0, feed.scrollHeight - feed.clientHeight - 80);
    feed.dispatchEvent(new Event('scroll', { bubbles: true }));
    await settle();
    await settle();
    feed.scrollTop = Math.max(0, feed.scrollHeight - feed.clientHeight - 12);
    feed.dispatchEvent(new Event('scroll', { bubbles: true }));
    await settle();
    await settle();
  });
  await page.waitForFunction(
    (selector) =>
      document.querySelector<HTMLElement>(selector)?.dataset.chatPinnedToBottom === 'false',
    FEED_SELECTOR,
    { timeout: 20_000 },
  );
  const growth = await page.locator(FEED_SELECTOR).evaluate(async (feedElement, itemSelector) => {
    const feed = feedElement as HTMLElement;
    const items = [...feed.querySelectorAll<HTMLElement>(itemSelector)].filter((item) =>
      item.querySelector('[data-chat-row-id]'),
    );
    const lastItem = items.at(-1);
    if (!lastItem) throw new Error('Detached growth target is missing.');
    const viewportRect = feed.getBoundingClientRect();
    const before = {
      scrollTop: feed.scrollTop,
      distanceFromEnd: feed.scrollHeight - feed.clientHeight - feed.scrollTop,
      scrollHeight: feed.scrollHeight,
      clientHeight: feed.clientHeight,
      virtualHeight:
        feed.querySelector<HTMLElement>('[data-chat-virtual-sizer]')?.getBoundingClientRect()
          .height ?? null,
      itemTop: lastItem.getBoundingClientRect().top - viewportRect.top,
      itemBottom: lastItem.getBoundingClientRect().bottom - viewportRect.top,
      itemHeight: lastItem.getBoundingClientRect().height,
    };
    lastItem.style.paddingBottom = '160px';
    for (let frame = 0; frame < 8; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    const after = {
      scrollTop: feed.scrollTop,
      distanceFromEnd: feed.scrollHeight - feed.clientHeight - feed.scrollTop,
      scrollHeight: feed.scrollHeight,
      clientHeight: feed.clientHeight,
      virtualHeight:
        feed.querySelector<HTMLElement>('[data-chat-virtual-sizer]')?.getBoundingClientRect()
          .height ?? null,
      itemTop: lastItem.getBoundingClientRect().top - viewportRect.top,
      itemBottom: lastItem.getBoundingClientRect().bottom - viewportRect.top,
      itemHeight: lastItem.getBoundingClientRect().height,
    };
    lastItem.style.paddingBottom = '';
    for (let frame = 0; frame < 4; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    return {
      before,
      after,
      movement: Math.abs(after.scrollTop - before.scrollTop),
    };
  }, ITEM_SELECTOR);
  expect(
    growth.after.itemHeight - growth.before.itemHeight,
    JSON.stringify(growth, null, 2),
  ).toBeGreaterThan(100);
  expect(
    growth.after.scrollHeight - growth.before.scrollHeight,
    JSON.stringify(growth, null, 2),
  ).toBeGreaterThan(100);
  expect(
    (growth.after.virtualHeight ?? 0) - (growth.before.virtualHeight ?? 0),
    JSON.stringify(growth, null, 2),
  ).toBeGreaterThan(100);
  expect(growth.movement, JSON.stringify(growth, null, 2)).toBeLessThanOrEqual(1);
}

async function readingAnchor(page: Page): Promise<ReadingAnchor> {
  return page.locator(FEED_SELECTOR).evaluate((feedElement, itemSelector) => {
    const feed = feedElement as HTMLElement;
    const viewport = feed.getBoundingClientRect();
    const candidates = [...feed.querySelectorAll<HTMLElement>(itemSelector)]
      .filter((item) => item.querySelector('[data-chat-row-id]'))
      .map((item) => ({ item, rect: item.getBoundingClientRect() }))
      .filter(({ rect }) => rect.bottom > viewport.top + 1 && rect.top < viewport.bottom - 1)
      .sort((left, right) => left.rect.top - right.rect.top);
    const anchor = candidates[0];
    const key = anchor?.item.dataset.chatVirtualItem;
    const row = anchor?.item.querySelector<HTMLElement>('[data-chat-row-id]');
    const rowId = row?.dataset.chatRowId;
    if (!anchor || !key || !row || !rowId) {
      throw new Error('No visible transcript item is available as an anchor.');
    }
    return {
      key,
      offset: anchor.rect.top - viewport.top,
      rowId,
      text: row.textContent?.trim() ?? '',
    };
  }, ITEM_SELECTOR);
}

async function startReadingAnchorFrameSampler(page: Page, anchor: ReadingAnchor): Promise<void> {
  await page.locator(FEED_SELECTOR).evaluate(
    async (feedElement, input) => {
      const feed = feedElement as HTMLElement;
      const browserGlobal = globalThis as typeof globalThis & {
        __chatReadingAnchorSampler?: {
          active: boolean;
          frame: number;
          key: string;
          node: HTMLElement;
          samples: ReadingAnchorFrameSample[];
        };
      };
      const node = [...feed.querySelectorAll<HTMLElement>(input.itemSelector)].find(
        (candidate) => candidate.dataset.chatVirtualItem === input.key,
      );
      if (!node) throw new Error('The reading-anchor wrapper is missing.');
      const sampler = {
        active: true,
        frame: 0,
        key: input.key,
        node,
        samples: [] as ReadingAnchorFrameSample[],
      };
      browserGlobal.__chatReadingAnchorSampler = sampler;
      const sample = () => {
        if (!sampler.active) return;
        const viewport = feed.getBoundingClientRect();
        const item = [...feed.querySelectorAll<HTMLElement>(input.itemSelector)].find(
          (candidate) => candidate.dataset.chatVirtualItem === sampler.key,
        );
        const row = item?.querySelector<HTMLElement>('[data-chat-row-id]');
        sampler.samples.push({
          busy: feed.getAttribute('aria-busy') === 'true',
          connected: sampler.node.isConnected,
          frame: sampler.frame,
          mountedKeys: [...feed.querySelectorAll<HTMLElement>(input.itemSelector)].map(
            (candidate) => candidate.dataset.chatVirtualItem ?? '',
          ),
          offset: item ? item.getBoundingClientRect().top - viewport.top : null,
          pinned: feed.dataset.chatPinnedToBottom === 'true',
          rowId: row?.dataset.chatRowId ?? null,
          sameNode: item === sampler.node,
          scrollTop: feed.scrollTop,
          text: row?.textContent?.trim() ?? null,
        });
        sampler.frame += 1;
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    },
    { itemSelector: ITEM_SELECTOR, key: anchor.key },
  );
}

async function beginTranscriptTouchDrag(page: Page): Promise<TranscriptTouchDrag> {
  const box = await page.locator(FEED_SELECTOR).boundingBox();
  if (!box) throw new Error('The transcript viewport has no touch target.');
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setTouchEmulationEnabled', {
    enabled: true,
    maxTouchPoints: 1,
  });
  const drag = {
    session,
    identifier: 1,
    maximumY: box.y + box.height - 20,
    x: box.x + box.width / 2,
    y: box.y + Math.min(120, box.height / 4),
  };
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      {
        id: drag.identifier,
        x: drag.x,
        y: drag.y,
        radiusX: 1,
        radiusY: 1,
        force: 1,
      },
    ],
  });
  return drag;
}

async function moveTranscriptTouch(
  page: Page,
  drag: TranscriptTouchDrag,
  deltaY: number,
): Promise<number> {
  drag.y = Math.min(drag.maximumY, drag.y + deltaY);
  await drag.session.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [
      {
        id: drag.identifier,
        x: drag.x,
        y: drag.y,
        radiusX: 1,
        radiusY: 1,
        force: 1,
      },
    ],
  });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  return page
    .locator(FEED_SELECTOR)
    .evaluate((feedElement) => (feedElement as HTMLElement).scrollTop);
}

async function finishTranscriptTouchDrag(drag: TranscriptTouchDrag): Promise<void> {
  try {
    await drag.session.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
    await drag.session.send('Emulation.setTouchEmulationEnabled', {
      enabled: false,
    });
  } finally {
    await drag.session.detach();
  }
}

async function installTranscriptScrollTopWriteTrap(page: Page): Promise<void> {
  await page.locator(FEED_SELECTOR).evaluate((feedElement) => {
    const feed = feedElement as HTMLElement;
    const browserGlobal = globalThis as typeof globalThis & {
      __chatScrollTopWriteTrap?: {
        coasting: boolean;
        feed: HTMLElement;
        restore(): void;
        writes: TranscriptScrollTopWrite[];
      };
    };
    browserGlobal.__chatScrollTopWriteTrap?.restore();
    const ownDescriptor = Object.getOwnPropertyDescriptor(feed, 'scrollTop');
    let owner: object | null = feed;
    let descriptor: PropertyDescriptor | undefined;
    while (owner && !descriptor) {
      descriptor = Object.getOwnPropertyDescriptor(owner, 'scrollTop');
      owner = Object.getPrototypeOf(owner);
    }
    if (!descriptor?.get || !descriptor.set) {
      throw new Error('The transcript scrollTop descriptor is unavailable.');
    }
    const trap = {
      coasting: false,
      feed,
      restore() {
        if (ownDescriptor) Object.defineProperty(feed, 'scrollTop', ownDescriptor);
        else Reflect.deleteProperty(feed, 'scrollTop');
        if (browserGlobal.__chatScrollTopWriteTrap === trap) {
          delete browserGlobal.__chatScrollTopWriteTrap;
        }
      },
      writes: [] as TranscriptScrollTopWrite[],
    };
    Object.defineProperty(feed, 'scrollTop', {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: () => descriptor.get!.call(feed) as number,
      set: (value: number) => {
        trap.writes.push({ duringCoasting: trap.coasting, value });
        descriptor.set!.call(feed, value);
      },
    });
    browserGlobal.__chatScrollTopWriteTrap = trap;
  });
}

async function transcriptScrollTopWrites(page: Page): Promise<TranscriptScrollTopWrite[]> {
  return page.evaluate(() => {
    const browserGlobal = globalThis as typeof globalThis & {
      __chatScrollTopWriteTrap?: { writes: TranscriptScrollTopWrite[] };
    };
    const writes = browserGlobal.__chatScrollTopWriteTrap?.writes;
    if (!writes) throw new Error('The transcript scrollTop write trap is missing.');
    return [...writes];
  });
}

async function startTranscriptCoastingHeartbeat(page: Page): Promise<void> {
  await page.locator(FEED_SELECTOR).evaluate((feedElement) => {
    const browserGlobal = globalThis as typeof globalThis & {
      __chatCoastingHeartbeat?: { active: boolean; frame: number };
      __chatScrollTopWriteTrap?: { coasting: boolean };
    };
    const trap = browserGlobal.__chatScrollTopWriteTrap;
    if (!trap) throw new Error('The transcript scrollTop write trap is missing.');
    if (browserGlobal.__chatCoastingHeartbeat) {
      browserGlobal.__chatCoastingHeartbeat.active = false;
    }
    const heartbeat = { active: true, frame: 0 };
    browserGlobal.__chatCoastingHeartbeat = heartbeat;
    trap.coasting = true;
    const feed = feedElement as HTMLElement;
    const pulse = () => {
      if (!heartbeat.active) return;
      feed.dispatchEvent(new Event('scroll', { bubbles: true }));
      heartbeat.frame += 1;
      requestAnimationFrame(pulse);
    };
    requestAnimationFrame(pulse);
  });
  await page.waitForFunction(() => {
    const browserGlobal = globalThis as typeof globalThis & {
      __chatCoastingHeartbeat?: { frame: number };
    };
    return (browserGlobal.__chatCoastingHeartbeat?.frame ?? 0) >= 2;
  });
}

async function waitForTranscriptCoastingFrames(
  page: Page,
  additionalFrames: number,
): Promise<void> {
  const target = await page.evaluate((frames) => {
    const browserGlobal = globalThis as typeof globalThis & {
      __chatCoastingHeartbeat?: { frame: number };
    };
    return (browserGlobal.__chatCoastingHeartbeat?.frame ?? 0) + frames;
  }, additionalFrames);
  await page.waitForFunction((minimum) => {
    const browserGlobal = globalThis as typeof globalThis & {
      __chatCoastingHeartbeat?: { frame: number };
    };
    return (browserGlobal.__chatCoastingHeartbeat?.frame ?? 0) >= minimum;
  }, target);
}

async function stopTranscriptCoastingHeartbeat(page: Page): Promise<void> {
  await page.evaluate(() => {
    const browserGlobal = globalThis as typeof globalThis & {
      __chatCoastingHeartbeat?: { active: boolean };
      __chatScrollTopWriteTrap?: { coasting: boolean };
    };
    if (browserGlobal.__chatCoastingHeartbeat) {
      browserGlobal.__chatCoastingHeartbeat.active = false;
      delete browserGlobal.__chatCoastingHeartbeat;
    }
    if (browserGlobal.__chatScrollTopWriteTrap) {
      browserGlobal.__chatScrollTopWriteTrap.coasting = false;
    }
  });
}

async function uninstallTranscriptScrollTopWriteTrap(page: Page): Promise<void> {
  await stopTranscriptCoastingHeartbeat(page);
  await page.evaluate(() => {
    const browserGlobal = globalThis as typeof globalThis & {
      __chatScrollTopWriteTrap?: { restore(): void };
    };
    browserGlobal.__chatScrollTopWriteTrap?.restore();
  });
}

async function startTranscriptMomentum(page: Page): Promise<void> {
  await page.locator(FEED_SELECTOR).evaluate((feedElement) => {
    const browserGlobal = globalThis as typeof globalThis & {
      __chatMomentum?: { active: boolean; frame: number };
    };
    const feed = feedElement as HTMLElement;
    const momentum = { active: true, frame: 0 };
    browserGlobal.__chatMomentum = momentum;
    const step = () => {
      if (!momentum.active) return;
      feed.scrollTop = Math.max(0, feed.scrollTop - 8);
      feed.dispatchEvent(new Event('scroll', { bubbles: true }));
      momentum.frame += 1;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  await page.waitForFunction(() => {
    const browserGlobal = globalThis as typeof globalThis & {
      __chatMomentum?: { frame: number };
    };
    return (browserGlobal.__chatMomentum?.frame ?? 0) >= 2;
  });
}

async function waitForTranscriptMomentumFrames(
  page: Page,
  additionalFrames: number,
): Promise<void> {
  const target = await page.evaluate((frames) => {
    const browserGlobal = globalThis as typeof globalThis & {
      __chatMomentum?: { frame: number };
    };
    return (browserGlobal.__chatMomentum?.frame ?? 0) + frames;
  }, additionalFrames);
  await page.waitForFunction((minimum) => {
    const browserGlobal = globalThis as typeof globalThis & {
      __chatMomentum?: { frame: number };
    };
    return (browserGlobal.__chatMomentum?.frame ?? 0) >= minimum;
  }, target);
}

async function stopTranscriptMomentum(page: Page): Promise<void> {
  await page.evaluate(() => {
    const browserGlobal = globalThis as typeof globalThis & {
      __chatMomentum?: { active: boolean };
    };
    if (browserGlobal.__chatMomentum) browserGlobal.__chatMomentum.active = false;
  });
  await page.locator(FEED_SELECTOR).evaluate(async (feedElement) => {
    const feed = feedElement as HTMLElement;
    let previous = feed.scrollTop;
    let stableFrames = 0;
    for (let frame = 0; stableFrames < 3; frame += 1) {
      if (frame > 300) {
        throw new Error('Transcript scroll never settled after momentum stop.');
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const current = feed.scrollTop;
      stableFrames = current === previous ? stableFrames + 1 : 0;
      previous = current;
    }
  });
}

async function finishReadingAnchorFrameSampler(page: Page): Promise<ReadingAnchorFrameSample[]> {
  return page.evaluate(async () => {
    const browserGlobal = globalThis as typeof globalThis & {
      __chatReadingAnchorSampler?: {
        active: boolean;
        samples: ReadingAnchorFrameSample[];
      };
    };
    const sampler = browserGlobal.__chatReadingAnchorSampler;
    if (!sampler) throw new Error('The reading-anchor frame sampler is missing.');
    for (let frame = 0; frame < 6; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    sampler.active = false;
    delete browserGlobal.__chatReadingAnchorSampler;
    return sampler.samples;
  });
}

async function anchorByKey(
  page: Page,
  key: string,
  context?: Record<string, unknown>,
): Promise<ReadingAnchor> {
  try {
    await page.waitForFunction(
      ({ itemSelector, expectedKey }) =>
        [...document.querySelectorAll<HTMLElement>(itemSelector)].some(
          (candidate) => candidate.dataset.chatVirtualItem === expectedKey,
        ),
      { itemSelector: ITEM_SELECTOR, expectedKey: key },
      { timeout: 20_000 },
    );
  } catch (error) {
    const expectedIdentity = (() => {
      try {
        const parsed = JSON.parse(key);
        return Array.isArray(parsed) && typeof parsed[0] === 'string' ? parsed[0] : null;
      } catch {
        return null;
      }
    })();
    const current = await page
      .locator(FEED_SELECTOR)
      .evaluate(
        (feedElement, input) => {
          const feed = feedElement as HTMLElement;
          const mountedKeys = [...feed.querySelectorAll<HTMLElement>(input.itemSelector)].flatMap(
            (item) => item.dataset.chatVirtualItem ?? [],
          );
          const mountedIdentities = [
            ...new Set(
              mountedKeys.flatMap((mountedKey) => {
                try {
                  const parsed = JSON.parse(mountedKey);
                  return Array.isArray(parsed) && typeof parsed[0] === 'string' ? [parsed[0]] : [];
                } catch {
                  return [];
                }
              }),
            ),
          ];
          const sizer = feed.querySelector<HTMLElement>(input.sizerSelector);
          return {
            mountedIdentities,
            mountedKeys,
            scrollTop: feed.scrollTop,
            maximumScrollTop: Math.max(0, feed.scrollHeight - feed.clientHeight),
            distanceFromEnd: feed.scrollHeight - feed.clientHeight - feed.scrollTop,
            pinned: feed.dataset.chatPinnedToBottom === 'true',
            userScrolledUp: feed.dataset.chatUserScrolledUp === 'true',
            modelCount: Number(sizer?.dataset.chatVirtualModelCount ?? 0),
            dataRevision: Number(sizer?.dataset.chatVirtualDataRevision ?? 0),
            scale: sizer?.dataset.chatTranscriptScale,
          };
        },
        { itemSelector: ITEM_SELECTOR, sizerSelector: SIZER_SELECTOR },
      )
      .catch(() => null);
    throw new Error(
      `Timed out waiting for the strict reading anchor:\n${JSON.stringify(
        { expectedKey: key, expectedIdentity, context, current },
        null,
        2,
      )}\n${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return page.locator(FEED_SELECTOR).evaluate(
    async (feedElement, input) => {
      const feed = feedElement as HTMLElement;
      let previousOffset: number | null = null;
      let stableFrames = 0;
      for (let attempt = 0; attempt < 24; attempt += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const item = [...feed.querySelectorAll<HTMLElement>(input.itemSelector)].find(
          (candidate) => candidate.dataset.chatVirtualItem === input.key,
        );
        if (!item) throw new Error(`Reading anchor ${input.key} became unmounted.`);
        const offset = item.getBoundingClientRect().top - feed.getBoundingClientRect().top;
        stableFrames =
          previousOffset !== null && Math.abs(offset - previousOffset) <= 0.5
            ? stableFrames + 1
            : 0;
        previousOffset = offset;
        if (stableFrames >= 3) return { key: input.key, offset };
      }
      throw new Error(`Reading anchor ${input.key} did not settle.`);
    },
    { itemSelector: ITEM_SELECTOR, key },
  );
}

async function transcriptLayoutSnapshot(
  page: Page,
  key: string,
): Promise<TranscriptLayoutSnapshot> {
  return page.locator(FEED_SELECTOR).evaluate(
    (feedElement, input) => {
      const feed = feedElement as HTMLElement;
      const anchor = [...feed.querySelectorAll<HTMLElement>(input.itemSelector)].find(
        (candidate) => candidate.dataset.chatVirtualItem === input.key,
      );
      const sizer = feed.querySelector<HTMLElement>(input.sizerSelector);
      if (!anchor || !sizer) throw new Error('Transcript layout snapshot is incomplete.');
      const feedRect = feed.getBoundingClientRect();
      const anchorRect = anchor.getBoundingClientRect();
      const sizerRect = sizer.getBoundingClientRect();
      const workspace = feed.closest<HTMLElement>('[data-conversation-workspace-layer]');
      const workspaceRect = workspace?.getBoundingClientRect();
      return {
        anchor: { key: input.key, offset: anchorRect.top - feedRect.top },
        anchorTransform: anchor.style.transform,
        feed: {
          top: feedRect.top,
          height: feedRect.height,
          scrollTop: feed.scrollTop,
          scrollHeight: feed.scrollHeight,
        },
        sizer: {
          top: sizerRect.top,
          height: sizerRect.height,
          declaredHeight: sizer.style.height,
          scale: sizer.dataset.chatTranscriptScale,
        },
        workspace: workspaceRect
          ? {
              top: workspaceRect.top,
              height: workspaceRect.height,
              styleTop: workspace?.style.top ?? '',
              styleHeight: workspace?.style.height ?? '',
            }
          : null,
      };
    },
    { itemSelector: ITEM_SELECTOR, key, sizerSelector: SIZER_SELECTOR },
  );
}

async function waitForRowCentered(page: Page, rowId: string, tolerance = 2): Promise<void> {
  try {
    await page.waitForFunction(
      ({ feedSelector, expectedRowId, maximumDelta }) => {
        const feed = document.querySelector<HTMLElement>(feedSelector);
        const row = [...document.querySelectorAll<HTMLElement>('[data-chat-row-id]')].find(
          (candidate) => candidate.dataset.chatRowId === expectedRowId,
        );
        if (!feed || !row) return false;
        const feedRect = feed.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        const delta = rowRect.top + rowRect.height / 2 - (feedRect.top + feedRect.height / 2);
        return Math.abs(delta) <= maximumDelta;
      },
      {
        feedSelector: FEED_SELECTOR,
        expectedRowId: rowId,
        maximumDelta: tolerance,
      },
      { timeout: 20_000 },
    );
  } catch (error) {
    const geometry = await page.locator(FEED_SELECTOR).evaluate((feedElement, expectedRowId) => {
      const feed = feedElement as HTMLElement;
      const row = [...document.querySelectorAll<HTMLElement>('[data-chat-row-id]')].find(
        (candidate) => candidate.dataset.chatRowId === expectedRowId,
      );
      const feedRect = feed.getBoundingClientRect();
      const rowRect = row?.getBoundingClientRect();
      return {
        rowMounted: Boolean(row),
        scrollTop: feed.scrollTop,
        distanceFromEnd: feed.scrollHeight - feed.clientHeight - feed.scrollTop,
        feedHeight: feedRect.height,
        rowTop: rowRect ? rowRect.top - feedRect.top : null,
        rowHeight: rowRect?.height ?? null,
        targetRowId: expectedRowId,
        mountedRowIds: [...document.querySelectorAll<HTMLElement>('[data-chat-row-id]')].map(
          (candidate) => candidate.dataset.chatRowId,
        ),
      };
    }, rowId);
    throw new Error(`Target row did not center: ${JSON.stringify(geometry)}`, {
      cause: error,
    });
  }
  await withDiagnosticTimeout(
    `centered target ${rowId} to settle`,
    page.locator(FEED_SELECTOR).evaluate(
      async (feedElement, input) => {
        const feed = feedElement as HTMLElement;
        let previous: { top: number; height: number } | null = null;
        let stableFrames = 0;
        for (let attempt = 0; attempt < 16; attempt += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const row = [...document.querySelectorAll<HTMLElement>('[data-chat-row-id]')].find(
            (candidate) => candidate.dataset.chatRowId === input.rowId,
          );
          if (!row) throw new Error(`Centered target ${input.rowId} became unmounted.`);
          const feedRect = feed.getBoundingClientRect();
          const rowRect = row.getBoundingClientRect();
          const current = {
            top: rowRect.top - feedRect.top,
            height: rowRect.height,
          };
          const delta = current.top + current.height / 2 - feedRect.height / 2;
          if (Math.abs(delta) > input.tolerance) {
            stableFrames = 0;
          } else if (
            previous &&
            Math.abs(previous.top - current.top) <= 0.5 &&
            Math.abs(previous.height - current.height) <= 0.5
          ) {
            stableFrames += 1;
          } else {
            stableFrames = 0;
          }
          previous = current;
          if (stableFrames >= 2) return;
        }
        throw new Error(`Centered target ${input.rowId} did not settle.`);
      },
      { rowId, tolerance },
    ),
  );
}

async function currentWorkspaceIdentity(
  page: Page,
): Promise<{ windowId: string; surfaceId: string }> {
  return page.evaluate(() => {
    const workspaceWindow = document.querySelector<HTMLElement>(
      '[data-workspace-window-current="true"]',
    );
    const windowId = workspaceWindow?.dataset.workspaceWindowId;
    const surfaceId = workspaceWindow?.dataset.workspaceWindowActiveSurface;
    if (!windowId || !surfaceId) throw new Error('Current workspace window identity is missing.');
    return { windowId, surfaceId };
  });
}

async function openCurrentWorkspaceTabActionsMenu(page: Page): Promise<void> {
  await page.evaluate(() => {
    const trigger = document.querySelector<HTMLButtonElement>(
      '[data-workspace-window-current="true"] [data-workspace-window-menu-trigger]',
    );
    if (!trigger) throw new Error('Current workspace window tab actions menu is missing.');
    if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
  });
}

async function openCurrentWorkspaceAddMenu(page: Page): Promise<void> {
  await page.evaluate(() => {
    const trigger = document.querySelector<HTMLButtonElement>(
      '[data-workspace-window-current="true"] [data-workspace-window-add-trigger]',
    );
    if (!trigger) throw new Error('Current workspace window add menu is missing.');
    if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
  });
}

async function clickMenuItem(page: Page, name: string): Promise<void> {
  await page.getByRole('menuitem', { name, exact: true }).click();
}

async function workspaceWindowIds(page: Page): Promise<string[]> {
  return page.locator('[data-workspace-window-id]').evaluateAll((windows) =>
    windows.flatMap((workspaceWindow) => {
      const windowId = workspaceWindow.getAttribute('data-workspace-window-id');
      return windowId ? [windowId] : [];
    }),
  );
}

async function openNewWorkspaceWindow(page: Page, name: string): Promise<string> {
  const workspaceWindows = page.locator('[data-workspace-window-id]');
  const existingWindowIds = new Set(await workspaceWindowIds(page));
  await page.locator('[data-workspace-new-window-menu]').click();
  await clickMenuItem(page, name);
  await page.waitForFunction(
    (expectedCount) =>
      document.querySelectorAll('[data-workspace-window-id]').length === expectedCount,
    existingWindowIds.size + 1,
  );
  const openedWindowId = (await workspaceWindowIds(page)).find(
    (windowId) => !existingWindowIds.has(windowId),
  );
  if (!openedWindowId) throw new Error(`New workspace window did not open for ${name}.`);
  await page.waitForFunction(
    (expectedWindowId) =>
      document
        .querySelector('[data-workspace-window-current="true"]')
        ?.getAttribute('data-workspace-window-id') === expectedWindowId,
    openedWindowId,
  );
  return openedWindowId;
}

async function focusWorkspaceWindow(page: Page, windowId: string): Promise<void> {
  await page
    .locator(`[data-workspace-window-id="${windowId}"]`)
    .dispatchEvent('pointerdown', { bubbles: true });
  await page.waitForFunction(
    (expectedWindowId) =>
      document
        .querySelector('[data-workspace-window-current="true"]')
        ?.getAttribute('data-workspace-window-id') === expectedWindowId,
    windowId,
  );
}

async function closeWorkspaceWindow(page: Page, windowId: string): Promise<void> {
  await page.locator(`[data-workspace-window-close="${windowId}"]`).click();
  await page.locator(`[data-workspace-window-id="${windowId}"]`).waitFor({ state: 'detached' });
}

async function selectWorkspaceWindowSurface(
  page: Page,
  windowId: string,
  surfaceId: string,
  programmatically = false,
): Promise<void> {
  const workspaceWindow = page.locator(`[data-workspace-window-id="${windowId}"]`);
  if ((await workspaceWindow.getAttribute('data-workspace-window-active-surface')) === surfaceId)
    return;
  const tab = workspaceWindow.locator(
    `[role="tab"][aria-controls="${windowId}-panel-${surfaceId}"]`,
  );
  if (programmatically) await tab.evaluate((element) => (element as HTMLElement).click());
  else await tab.click();
  await page.waitForFunction(
    ({ expectedWindowId, expectedSurfaceId }) =>
      document
        .querySelector(`[data-workspace-window-id="${expectedWindowId}"]`)
        ?.getAttribute('data-workspace-window-active-surface') === expectedSurfaceId,
    { expectedWindowId: windowId, expectedSurfaceId: surfaceId },
  );
}

async function waitForTranscriptScale(page: Page, scale: number): Promise<void> {
  await page
    .locator(`${SIZER_SELECTOR}[data-chat-transcript-scale="${scale}"]`)
    .waitFor({ state: 'visible' });
  await page.locator(FEED_SELECTOR).evaluate(async () => {
    for (let frame = 0; frame < 4; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  });
}

async function userMessageNavigatorRowIdContaining(page: Page, text: string): Promise<string> {
  const hasTarget = await page.evaluate(
    (expected) =>
      [...document.querySelectorAll<HTMLElement>('[data-user-message-navigator-row]')].some(
        (candidate) => candidate.textContent?.includes(expected),
      ),
    text,
  );
  if (!hasTarget) {
    await page.locator('[data-user-message-navigator-list]').evaluate((listElement) => {
      const list = listElement as HTMLElement;
      list.scrollTop = list.scrollHeight;
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await page.waitForFunction(
      (expected) =>
        [...document.querySelectorAll<HTMLElement>('[data-user-message-navigator-row]')].some(
          (candidate) => candidate.textContent?.includes(expected),
        ),
      text,
      { timeout: 20_000 },
    );
  }
  return page.evaluate((expected) => {
    const row = [
      ...document.querySelectorAll<HTMLElement>('[data-user-message-navigator-row]'),
    ].find((candidate) => candidate.textContent?.includes(expected));
    const rowId = row?.dataset.userMessageNavigatorRow;
    if (!rowId) throw new Error(`Missing user-message navigator row containing: ${expected}`);
    return rowId;
  }, text);
}

async function clickUserMessageNavigatorRowContaining(page: Page, text: string): Promise<void> {
  await page.evaluate((expected) => {
    const row = [
      ...document.querySelectorAll<HTMLButtonElement>('[data-user-message-navigator-row]'),
    ].find((candidate) => candidate.textContent?.includes(expected));
    if (!row) throw new Error(`Missing user-message navigator row containing: ${expected}`);
    row.click();
  }, text);
}

async function viewportPolicy(page: Page): Promise<{ pinned: boolean; userScrolledUp: boolean }> {
  return page.locator(FEED_SELECTOR).evaluate((feedElement) => {
    const feed = feedElement as HTMLElement;
    return {
      pinned: feed.dataset.chatPinnedToBottom === 'true',
      userScrolledUp: feed.dataset.chatUserScrolledUp === 'true',
    };
  });
}

async function selectAndVerifyEdgeNavigatorTarget(
  page: Page,
  marker: string,
  edge: 'start' | 'end',
): Promise<void> {
  await openCurrentWorkspaceTabActionsMenu(page);
  await clickMenuItem(page, 'Jump to user message');
  await page.getByText('User messages', { exact: true }).waitFor();
  const rowId = await userMessageNavigatorRowIdContaining(page, marker);
  await clickUserMessageNavigatorRowContaining(page, marker);
  await page.getByText('User messages', { exact: true }).waitFor({ state: 'hidden' });
  await page.waitForFunction(
    (input) => {
      const feed = document.querySelector<HTMLElement>(input.feedSelector);
      if (!feed) return false;
      const row = [...feed.querySelectorAll<HTMLElement>('[data-chat-row-id]')].find(
        (candidate) => candidate.dataset.chatRowId === input.rowId,
      );
      const atEdge =
        input.edge === 'start'
          ? feed.scrollTop <= 1
          : feed.scrollHeight - feed.clientHeight - feed.scrollTop <= 1;
      return Boolean(row && atEdge);
    },
    { feedSelector: FEED_SELECTOR, rowId, edge },
    { timeout: 20_000 },
  );
}

async function installDelayedTargetGrowth(page: Page, rowId: string): Promise<void> {
  await page.evaluate((expectedRowId) => {
    const browserGlobal = globalThis as typeof globalThis & {
      __chatDelayedTargetGrowthFrame?: number;
      __stopDelayedTargetGrowth?: () => void;
    };
    browserGlobal.__stopDelayedTargetGrowth?.();
    let cancelled = false;
    let observer: MutationObserver | null = null;
    let growingRow: HTMLElement | null = null;
    browserGlobal.__chatDelayedTargetGrowthFrame = 0;
    browserGlobal.__stopDelayedTargetGrowth = () => {
      cancelled = true;
      observer?.disconnect();
      growingRow?.style.removeProperty('padding-bottom');
      delete browserGlobal.__chatDelayedTargetGrowthFrame;
    };
    const growTarget = (): boolean => {
      const row = [...document.querySelectorAll<HTMLElement>('[data-chat-row-id]')].find(
        (candidate) => candidate.dataset.chatRowId === expectedRowId,
      );
      if (!row) return false;
      growingRow = row;
      let frame = 0;
      const grow = () => {
        if (cancelled || frame >= 60 || !row.isConnected) return;
        frame += 1;
        browserGlobal.__chatDelayedTargetGrowthFrame = frame;
        row.style.paddingBottom = `${frame * 40}px`;
        requestAnimationFrame(grow);
      };
      requestAnimationFrame(grow);
      return true;
    };
    if (growTarget()) return;
    observer = new MutationObserver(() => {
      if (!growTarget()) return;
      observer?.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }, rowId);
}

async function installHeldTargetCompletion(page: Page, rowId: string): Promise<void> {
  await page.evaluate((expectedRowId) => {
    const browserGlobal = globalThis as typeof globalThis & {
      __completeHeldChatTarget?: () => void;
    };
    const holdTarget = (): boolean => {
      const row = [...document.querySelectorAll<HTMLElement>('[data-chat-row-id]')].find(
        (candidate) => candidate.dataset.chatRowId === expectedRowId,
      );
      if (!row) return false;
      row.dataset.chatLayoutPending = 'true';
      browserGlobal.__completeHeldChatTarget = () => {
        row.removeAttribute('data-chat-layout-pending');
        delete browserGlobal.__completeHeldChatTarget;
      };
      return true;
    };
    if (holdTarget()) return;
    const observer = new MutationObserver(() => {
      if (!holdTarget()) return;
      observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }, rowId);
}

async function selectNavigatorTargetDuringAppend(
  fixture: ChromiumFixture,
  chatId: string,
  marker: string,
): Promise<void> {
  await openCurrentWorkspaceTabActionsMenu(fixture.page);
  await clickMenuItem(fixture.page, 'Jump to user message');
  await fixture.page.getByText('User messages', { exact: true }).waitFor();
  const rowId = await userMessageNavigatorRowIdContaining(fixture.page, marker);
  const appendedContent = 'chromium-target-concurrent-append';
  const heldCompletion = fixture.integration.fakeProviders.openAi.holdNext({
    lastUserText: appendedContent,
  });
  await installHeldTargetCompletion(fixture.page, rowId);
  await clickUserMessageNavigatorRowContaining(fixture.page, marker);
  await fixture.page.waitForFunction(
    (expectedRowId) =>
      [...document.querySelectorAll<HTMLElement>('[data-chat-row-id]')].some(
        (candidate) => candidate.dataset.chatRowId === expectedRowId,
      ),
    rowId,
    { timeout: 20_000 },
  );
  const dataRevision = await virtualDataRevision(fixture.page);

  let turnId: string | null = null;
  try {
    const accepted = await fixture.integration.client.runDirectChat({
      chatId,
      content: appendedContent,
      agent: fixture.integration.directAgents.openAi,
    });
    turnId = accepted.turnId ?? null;
    await withDiagnosticTimeout('the concurrent append request', heldCompletion.received);
    await waitForVirtualDataRevisionAfter(fixture.page, dataRevision);
    expect(
      await fixture.page
        .locator(`[data-chat-row-id="${rowId}"]`)
        .getAttribute('data-chat-layout-pending'),
    ).toBe('true');
    expect(
      await fixture.page.locator(FEED_SELECTOR).getAttribute('data-chat-pinned-to-bottom'),
    ).toBe('false');
    const detachedGeometry = await fixture.page.locator(FEED_SELECTOR).evaluate((feed) => ({
      distanceFromEnd: feed.scrollHeight - feed.clientHeight - feed.scrollTop,
      viewportHeight: feed.clientHeight,
    }));
    expect(detachedGeometry.distanceFromEnd).toBeGreaterThan(detachedGeometry.viewportHeight);
    await fixture.page.evaluate(() => {
      const browserGlobal = globalThis as typeof globalThis & {
        __completeHeldChatTarget?: () => void;
      };
      browserGlobal.__completeHeldChatTarget?.();
    });

    await waitForRowCentered(fixture.page, rowId);
    await fixture.page.getByText('User messages', { exact: true }).waitFor({ state: 'hidden' });
  } finally {
    heldCompletion.releaseEcho();
  }
  if (turnId === null) throw new Error('Concurrent append turn was not accepted.');
  expect((await fixture.integration.client.waitForTurnTerminal(chatId, turnId)).type).toBe(
    'agent-run-finished',
  );
  await waitForRowCentered(fixture.page, rowId);
}

async function installDelayedTargetCompletion(page: Page, rowId: string): Promise<void> {
  await page.evaluate((expectedRowId) => {
    const completeTarget = (): boolean => {
      const row = [...document.querySelectorAll<HTMLElement>('[data-chat-row-id]')].find(
        (candidate) => candidate.dataset.chatRowId === expectedRowId,
      );
      if (!row) return false;
      row.dataset.chatLayoutPending = 'true';
      let frame = 0;
      const complete = () => {
        if (!row.isConnected) return;
        frame += 1;
        if (frame === 12) row.style.paddingBottom = '600px';
        if (frame >= 16) {
          row.removeAttribute('data-chat-layout-pending');
          return;
        }
        requestAnimationFrame(complete);
      };
      requestAnimationFrame(complete);
      return true;
    };
    if (completeTarget()) return;
    const observer = new MutationObserver(() => {
      if (!completeTarget()) return;
      observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }, rowId);
}

async function selectAndVerifyNavigatorTarget(page: Page, marker: string): Promise<void> {
  await openCurrentWorkspaceTabActionsMenu(page);
  await clickMenuItem(page, 'Jump to user message');
  await page.getByText('User messages', { exact: true }).waitFor();
  const rowId = await userMessageNavigatorRowIdContaining(page, marker);
  await clickUserMessageNavigatorRowContaining(page, marker);
  await page.getByText('User messages', { exact: true }).waitFor({ state: 'hidden' });
  await waitForRowCentered(page, rowId);
}

async function selectAndVerifyDelayedNavigatorTarget(page: Page, marker: string): Promise<void> {
  await openCurrentWorkspaceTabActionsMenu(page);
  await clickMenuItem(page, 'Jump to user message');
  await page.getByText('User messages', { exact: true }).waitFor();
  const rowId = await userMessageNavigatorRowIdContaining(page, marker);
  await installDelayedTargetCompletion(page, rowId);
  await clickUserMessageNavigatorRowContaining(page, marker);
  await page.getByText('User messages', { exact: true }).waitFor({ state: 'hidden' });
  await waitForRowCentered(page, rowId);
}

async function interruptNavigatorJump(page: Page, marker: string): Promise<void> {
  await openCurrentWorkspaceTabActionsMenu(page);
  await clickMenuItem(page, 'Jump to user message');
  await page.getByText('User messages', { exact: true }).waitFor();
  const rowId = await userMessageNavigatorRowIdContaining(page, marker);
  await installDelayedTargetGrowth(page, rowId);
  let trapInstalled = false;
  try {
    await installTranscriptScrollTopWriteTrap(page);
    trapInstalled = true;
    await clickUserMessageNavigatorRowContaining(page, marker);
    await page.waitForFunction(
      (expectedRowId) =>
        [...document.querySelectorAll<HTMLElement>('[data-chat-row-id]')].some(
          (candidate) => candidate.dataset.chatRowId === expectedRowId,
        ),
      rowId,
      { timeout: 20_000 },
    );
    const writesAtMount = (await transcriptScrollTopWrites(page)).length;
    await page.waitForFunction(
      (minimumWrites) => {
        const browserGlobal = globalThis as typeof globalThis & {
          __chatDelayedTargetGrowthFrame?: number;
          __chatScrollTopWriteTrap?: { writes: TranscriptScrollTopWrite[] };
        };
        return (
          (browserGlobal.__chatDelayedTargetGrowthFrame ?? 0) >= 5 &&
          (browserGlobal.__chatScrollTopWriteTrap?.writes.length ?? 0) > minimumWrites
        );
      },
      writesAtMount,
      { timeout: 20_000 },
    );
    const writesBeforeIntent = (await transcriptScrollTopWrites(page)).length;
    const box = await page.locator(FEED_SELECTOR).boundingBox();
    if (!box) throw new Error('Transcript viewport has no interaction bounds.');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -600);
    const writes = await withDiagnosticTimeout(
      'the cancelled navigator jump to stop writing',
      page.evaluate(async () => {
        const browserGlobal = globalThis as typeof globalThis & {
          __chatDelayedTargetGrowthFrame?: number;
          __chatScrollTopWriteTrap?: { writes: TranscriptScrollTopWrite[] };
        };
        for (let frame = 0; frame < 2; frame += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        const afterCancellation = browserGlobal.__chatScrollTopWriteTrap?.writes.length ?? 0;
        for (let frame = 0; frame < 45; frame += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        return {
          afterCancellation,
          final: browserGlobal.__chatScrollTopWriteTrap?.writes.length ?? 0,
          growthFrames: browserGlobal.__chatDelayedTargetGrowthFrame ?? 0,
        };
      }),
    );
    expect(writesBeforeIntent).toBeGreaterThan(writesAtMount);
    expect(writes.growthFrames).toBeGreaterThanOrEqual(5);
    expect(writes.final).toBe(writes.afterCancellation);
    await page.getByText('User messages', { exact: true }).waitFor({ state: 'hidden' });
  } finally {
    await page.evaluate(() => {
      const browserGlobal = globalThis as typeof globalThis & {
        __stopDelayedTargetGrowth?: () => void;
      };
      browserGlobal.__stopDelayedTargetGrowth?.();
      delete browserGlobal.__stopDelayedTargetGrowth;
    });
    if (trapInstalled) await uninstallTranscriptScrollTopWriteTrap(page);
  }
}

async function transcriptGeometry(page: Page): Promise<TranscriptGeometry> {
  return page.locator(FEED_SELECTOR).evaluate(
    (feedElement, input) => {
      const feed = feedElement as HTMLElement;
      const viewport = feed.getBoundingClientRect();
      const sizer = feed.querySelector<HTMLElement>(input.sizerSelector);
      if (!sizer) throw new Error('Virtual transcript sizer is missing.');
      const items = [...feed.querySelectorAll<HTMLElement>(input.itemSelector)]
        .map((item) => ({
          key: item.dataset.chatVirtualItem ?? '',
          rect: item.getBoundingClientRect(),
          hasTranscriptRow: Boolean(item.querySelector('[data-chat-row-id]')),
        }))
        .sort((left, right) => left.rect.top - right.rect.top);
      const overlaps: TranscriptGeometry['overlaps'] = [];
      for (let index = 1; index < items.length; index += 1) {
        const previous = items[index - 1];
        const next = items[index];
        if (previous && next && next.rect.top < previous.rect.bottom - 1) {
          overlaps.push({
            previous: previous.key,
            next: next.key,
            amount: previous.rect.bottom - next.rect.top,
          });
        }
      }
      return {
        distanceFromEnd: feed.scrollHeight - feed.clientHeight - feed.scrollTop,
        itemCount: items.length,
        transcriptItemCount: items.filter((item) => item.hasTranscriptRow).length,
        modelCount: Number(sizer.dataset.chatVirtualModelCount ?? 0),
        overlaps,
        horizontalOverflow: items
          .filter(({ rect }) => rect.left < viewport.left - 1 || rect.right > viewport.right + 1)
          .map(({ key, rect }) => ({
            key,
            left: rect.left,
            right: rect.right,
          })),
      };
    },
    { itemSelector: ITEM_SELECTOR, sizerSelector: SIZER_SELECTOR },
  );
}

async function mountedConversationDiscontinuities(
  page: Page,
): Promise<Array<{ previous: string; next: string; delta: number }>> {
  return page.locator(FEED_SELECTOR).evaluate((feedElement, itemSelector) => {
    const items = [...feedElement.querySelectorAll<HTMLElement>(itemSelector)]
      .map((item) => ({
        index: Number(item.dataset.index),
        key: item.dataset.chatVirtualItem ?? '',
        rect: item.getBoundingClientRect(),
      }))
      .filter((item) => Number.isFinite(item.index))
      .sort((left, right) => left.index - right.index);
    const discontinuities: Array<{
      previous: string;
      next: string;
      delta: number;
    }> = [];
    for (let index = 1; index < items.length; index += 1) {
      const previous = items[index - 1];
      const next = items[index];
      if (!previous || !next || next.index !== previous.index + 1) continue;
      const delta = next.rect.top - previous.rect.bottom;
      if (Math.abs(delta) > 1) {
        discontinuities.push({ previous: previous.key, next: next.key, delta });
      }
    }
    return discontinuities;
  }, ITEM_SELECTOR);
}

async function diagnostics(fixture: ChromiumFixture): Promise<unknown> {
  return {
    geometry: await transcriptGeometry(fixture.page).catch(() => null),
    mountedKeys: await fixture.page
      .locator(ITEM_SELECTOR)
      .evaluateAll((items) =>
        items.map((item) => (item as HTMLElement).dataset.chatVirtualItem ?? ''),
      )
      .catch(() => []),
  };
}

async function createTranscript(fixture: ChromiumFixture): Promise<string> {
  const chatId = await seedTranscript(fixture.integration, 60);
  const response = await fixture.page.goto(
    `${fixture.integration.garcon.baseUrl}/chat/${encodeURIComponent(chatId)}`,
    { waitUntil: 'domcontentloaded' },
  );
  if (!response?.ok()) throw new Error(`SPA navigation failed with ${response?.status()}.`);

  await waitForTranscriptReady(fixture.page);
  // Appending never rotates the transcript view, so the surface identity is expected to
  // hold here; the appended turn rendering is what proves the feed caught up.
  await appendTurn(fixture.integration, chatId, 'chromium-generation-prime');
  await fixture.page
    .locator(FEED_SELECTOR)
    .getByText('echo:chromium-generation-prime', { exact: true })
    .waitFor();
  await waitForTranscriptReady(fixture.page);
  return chatId;
}

async function verifyEarlierPrefetchDuringProcessing(fixture: ChromiumFixture): Promise<void> {
  const chatId = await seedTranscript(fixture.integration, 90, 'chromium-processing-prefetch');
  await prepareTranscript(fixture, chatId);
  const prompt = 'chromium-processing-prefetch-held';
  const heldCompletion = fixture.integration.fakeProviders.openAi.holdNext({
    lastUserText: prompt,
  });
  let releaseFirstPage!: () => void;
  const firstPageGate = new Promise<void>((resolve) => (releaseFirstPage = resolve));
  let earlierRequestCount = 0;
  let firstDemandRequestBaseline = 0;
  let turnId: string | null = null;
  const waitForEarlierRequest = () =>
    fixture.page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.searchParams.get('chatId') === chatId && url.searchParams.has('beforeOrdinal');
    });

  try {
    const accepted = await fixture.integration.client.runDirectChat({
      chatId,
      content: prompt,
      agent: fixture.integration.directAgents.openAi,
    });
    turnId = accepted.turnId ?? null;
    await withDiagnosticTimeout('the held processing turn', heldCompletion.received);
    await fixture.page
      .locator('[data-slot="chat-processing-status"]')
      .waitFor({ state: 'visible' });
    const modelCountBeforePrefetch = await waitForStableModelCount(fixture.page, 50);
    firstDemandRequestBaseline = earlierRequestCount;
    await fixture.page.route('**/api/v1/chats/messages?**', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('chatId') === chatId && url.searchParams.has('beforeOrdinal')) {
        earlierRequestCount += 1;
        if (earlierRequestCount === firstDemandRequestBaseline + 1) await firstPageGate;
      }
      await route.continue();
    });
    const firstPageRequest = waitForEarlierRequest();

    const loadAheadDistance = await fixture.page.locator(FEED_SELECTOR).evaluate((feedElement) => {
      const feed = feedElement as HTMLElement;
      const maximum = Math.max(0, feed.scrollHeight - feed.clientHeight);
      const start = Math.min(maximum, feed.clientHeight * 2.5);
      if (start <= feed.clientHeight * 2) {
        throw new Error('The transcript is too short to verify two-viewport load-ahead.');
      }
      feed.scrollTop = start;
      feed.dispatchEvent(new Event('scroll', { bubbles: true }));
      feed.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          pointerType: 'mouse',
        }),
      );
      feed.scrollTop = feed.clientHeight * 1.5;
      feed.dispatchEvent(new Event('scroll', { bubbles: true }));
      return feed.scrollTop;
    });
    await withDiagnosticTimeout('the first held earlier-page request', firstPageRequest);
    expect(loadAheadDistance).toBeGreaterThan(0);
    expect(await transcriptBoundaryIntersectsViewport(fixture.page, 'earlier')).toBe(false);
    const earlierLoadingIndicator = fixture.page.locator('[data-chat-earlier-loading-indicator]');
    await earlierLoadingIndicator.waitFor({ state: 'visible' });

    expect(await fixture.page.locator('[data-transcript-page-boundary="earlier"]').count()).toBe(0);
    const boundarySweep = await fixture.page
      .locator(FEED_SELECTOR)
      .evaluate(async (feedElement) => {
        const feed = feedElement as HTMLElement;
        const offsets: number[] = [];
        const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        for (let attempt = 0; attempt < 32 && feed.scrollTop > 0; attempt += 1) {
          offsets.push(feed.scrollTop);
          feed.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -80 }));
          feed.scrollTop = Math.max(0, feed.scrollTop - feed.clientHeight / 4);
          feed.dispatchEvent(new Event('scroll', { bubbles: true }));
          await frame();
        }
        return { offsets, scrollTop: feed.scrollTop };
      });
    expect(boundarySweep.scrollTop, JSON.stringify(boundarySweep, null, 2)).toBe(0);
    expect(await fixture.page.locator('[data-transcript-page-boundary="earlier"]').count()).toBe(0);
    const prependAnchor = await readingAnchor(fixture.page);
    await startReadingAnchorFrameSampler(fixture.page, prependAnchor);
    await fixture.page.locator(FEED_SELECTOR).evaluate(
      (feedElement, input) => {
        const feed = feedElement as HTMLElement;
        const browserGlobal = globalThis as typeof globalThis & {
          __chatClampedEarlierIntentPump?: {
            complete: boolean;
            frames: number;
            growthFrame: number | null;
            observedModelCount: number;
          };
        };
        const pumpState = {
          complete: false,
          frames: 0,
          growthFrame: null as number | null,
          observedModelCount: input.initialModelCount,
        };
        browserGlobal.__chatClampedEarlierIntentPump = pumpState;
        const pump = () => {
          feed.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -80 }));
          pumpState.frames += 1;
          const sizer = feed.querySelector<HTMLElement>(input.sizerSelector);
          pumpState.observedModelCount = Number(sizer?.dataset.chatVirtualModelCount ?? Number.NaN);
          if (pumpState.observedModelCount > input.initialModelCount) {
            pumpState.growthFrame = pumpState.frames;
            pumpState.complete = true;
          } else if (pumpState.frames >= 180) {
            pumpState.complete = true;
          } else {
            requestAnimationFrame(pump);
          }
        };
        requestAnimationFrame(pump);
      },
      {
        initialModelCount: modelCountBeforePrefetch,
        sizerSelector: SIZER_SELECTOR,
      },
    );

    releaseFirstPage();

    await fixture.page.waitForFunction(
      () =>
        (
          globalThis as typeof globalThis & {
            __chatClampedEarlierIntentPump?: { complete: boolean };
          }
        ).__chatClampedEarlierIntentPump?.complete === true,
    );
    const intentPump = await fixture.page.evaluate(() => {
      const browserGlobal = globalThis as typeof globalThis & {
        __chatClampedEarlierIntentPump?: {
          complete: boolean;
          frames: number;
          growthFrame: number | null;
          observedModelCount: number;
        };
      };
      const result = browserGlobal.__chatClampedEarlierIntentPump;
      delete browserGlobal.__chatClampedEarlierIntentPump;
      return result;
    });
    expect(intentPump?.growthFrame, JSON.stringify(intentPump, null, 2)).not.toBeNull();
    expect(intentPump?.growthFrame).toBe(intentPump?.frames);
    expect(intentPump?.observedModelCount).toBeGreaterThan(modelCountBeforePrefetch);
    const modelCountAfterFirstPage = await waitForStableModelCount(
      fixture.page,
      modelCountBeforePrefetch + 50,
    );
    await earlierLoadingIndicator.waitFor({ state: 'detached' });
    const prependFrames = await finishReadingAnchorFrameSampler(fixture.page);
    expect(
      Math.max(
        ...prependFrames.map((sample) =>
          sample.offset === null
            ? Number.POSITIVE_INFINITY
            : Math.abs(sample.offset - prependAnchor.offset),
        ),
      ),
      JSON.stringify({ prependAnchor, prependFrames }, null, 2),
    ).toBeLessThanOrEqual(1);
    const firstDemandRequestCount = earlierRequestCount;
    expect(firstDemandRequestCount).toBeGreaterThan(firstDemandRequestBaseline);
    expect(modelCountAfterFirstPage).toBe(modelCountBeforePrefetch + 50);

    await fixture.page.locator(FEED_SELECTOR).evaluate((feedElement) => {
      const feed = feedElement as HTMLElement;
      feed.scrollTop = 0;
      feed.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    // A clamped viewport emits no scroll event for the subsequent upward gesture.
    const secondDemandRequestBaseline = earlierRequestCount;
    const secondPageRequest = waitForEarlierRequest();
    await signalScrollIntent(fixture.page, 'earlier');
    await withDiagnosticTimeout('the clamped-gesture earlier-page request', secondPageRequest);
    const modelCountAfterPrefetch = await waitForModelCount(
      fixture.page,
      modelCountBeforePrefetch + 100,
    );
    expect(earlierRequestCount).toBeGreaterThan(secondDemandRequestBaseline);
    expect(modelCountAfterPrefetch).toBe(modelCountBeforePrefetch + 100);
  } finally {
    releaseFirstPage();
    heldCompletion.releaseEcho();
    await fixture.page.unroute('**/api/v1/chats/messages?**');
  }

  if (turnId === null) throw new Error('The held processing turn was not accepted.');
  expect((await fixture.integration.client.waitForTurnTerminal(chatId, turnId)).type).toBe(
    'agent-run-finished',
  );
  fixture.assertNoBrowserErrors();
}

async function verifyTouchDragPrepend(
  fixture: ChromiumFixture,
  scenario: TouchPrependScenario,
): Promise<void> {
  await fixture.page.setViewportSize(scenario.viewport);
  const chatId = await seedTranscript(fixture.integration, 90, `chromium-touch-${scenario.label}`);
  let releaseEarlierPage!: () => void;
  const earlierPageGate = new Promise<void>((resolve) => (releaseEarlierPage = resolve));
  let resolveEarlierRequest!: () => void;
  const earlierRequest = new Promise<void>((resolve) => (resolveEarlierRequest = resolve));
  let earlierRequestCount = 0;
  let gestureRequestBaseline = 0;
  let drag: TranscriptTouchDrag | null = null;
  let liveHold: ReturnType<typeof fixture.integration.fakeProviders.openAi.holdNext> | null = null;
  let liveTurnId: string | null = null;
  let liveAbort: Promise<unknown> | null = null;
  let stopLiveTurn: ReturnType<typeof fixture.integration.client.stopChat> | null = null;
  let queuedPrompt: string | null = null;
  let queuePauseId: string | null = null;

  try {
    await prepareTranscript(fixture, chatId);
    let initialEntryCount = await transcriptEntryCount(fixture.page);
    expect(initialEntryCount).toBe(50);
    gestureRequestBaseline = earlierRequestCount;
    await fixture.page.route('**/api/v1/chats/messages?**', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('chatId') === chatId && url.searchParams.has('beforeOrdinal')) {
        earlierRequestCount += 1;
        if (earlierRequestCount === gestureRequestBaseline + 1) {
          resolveEarlierRequest();
          await earlierPageGate;
        }
      }
      await route.continue();
    });
    if (scenario.liveBehavior !== 'completed') {
      const prompt = `chromium-touch-live-${scenario.label}`;
      liveHold = fixture.integration.fakeProviders.openAi.holdNext({
        lastUserText: prompt,
      });
      const accepted = await fixture.integration.client.runDirectChat({
        chatId,
        content: prompt,
        agent: fixture.integration.directAgents.openAi,
      });
      if (!accepted.turnId) throw new Error('The held mobile touch turn has no turn ID.');
      liveTurnId = accepted.turnId;
      await withDiagnosticTimeout('the held touch-drag turn', liveHold.received);
      initialEntryCount = await waitForTranscriptEntryCount(fixture.page, initialEntryCount + 1);
      await waitForStablePinnedTranscriptLayout(fixture.page, `${scenario.label}-held-live`);
      if (scenario.liveBehavior === 'paused-interrupted') {
        queuedPrompt = `chromium-touch-queued-${scenario.label}`;
        const queued = await fixture.integration.client.enqueueNew(chatId, queuedPrompt);
        expect(queued.control.queue.entries.map((entry) => entry.content)).toContain(queuedPrompt);
        const paused = await fixture.integration.client.pauseQueue(chatId);
        expect(paused.control.queue.pause?.kind).toBe('manual');
        queuePauseId = paused.control.queue.pause?.id ?? null;
        expect(queuePauseId).not.toBeNull();
      }
      await scrollToPosition(fixture.page, 'middle');
    }
    await fixture.page.locator(FEED_SELECTOR).evaluate(async (feedElement, clampBeforeRelease) => {
      const feed = feedElement as HTMLElement;
      const requested = clampBeforeRelease ? 260 : feed.clientHeight * 2.5;
      feed.scrollTop = Math.min(requested, Math.max(0, feed.scrollHeight - feed.clientHeight));
      feed.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }, scenario.clampBeforeRelease);

    drag = await beginTranscriptTouchDrag(fixture.page);
    for (let step = 0; step < 24; step += 1) {
      await moveTranscriptTouch(fixture.page, drag, scenario.clampBeforeRelease ? 80 : 24);
      if (earlierRequestCount > gestureRequestBaseline) break;
    }
    await withDiagnosticTimeout('the held touch-drag earlier-page request', earlierRequest);
    if (scenario.clampBeforeRelease) {
      for (let step = 0; step < 20; step += 1) {
        if ((await moveTranscriptTouch(fixture.page, drag, 24)) <= 1) break;
      }
      expect(
        await fixture.page
          .locator(FEED_SELECTOR)
          .evaluate((feedElement) => (feedElement as HTMLElement).scrollTop),
      ).toBeLessThanOrEqual(1);
    }

    const anchor = await readingAnchor(fixture.page);
    if (!anchor.rowId || anchor.text === undefined) {
      throw new Error('The touch-drag reading anchor has no rendered row identity.');
    }
    await startReadingAnchorFrameSampler(fixture.page, anchor);
    let expectedEntryCount = initialEntryCount + 50;
    if (scenario.liveBehavior === 'expanding' && liveHold) {
      expect(
        liveHold.releaseText(`Live response expands during the ${scenario.label} prepend.`),
      ).toBe(true);
      expect(await waitForTranscriptEntryCount(fixture.page, initialEntryCount + 1)).toBe(
        initialEntryCount + 1,
      );
      expectedEntryCount += 1;
    } else if (scenario.liveBehavior === 'paused-interrupted' && liveHold) {
      const preStopPublication = await touchPublicationSnapshot(fixture.page);
      liveAbort = liveHold.expectAbort();
      const stopCursor = fixture.integration.client.markEvents();
      stopLiveTurn = fixture.integration.client.stopChat({
        agentId: fixture.integration.directAgents.openAi.agentId,
        chatId,
        clientRequestId: crypto.randomUUID(),
      });
      expect((await stopLiveTurn).outcome).toBe('interrupt-requested');
      await fixture.integration.client.waitForProcessing(chatId, false, {
        afterIndex: stopCursor,
      });
      // The interrupt lifecycle must be published in the model before the
      // baseline-delta oracle is established, or the delta misattributes it.
      await fixture.page.waitForFunction((preStopRevision) => {
        const sizer = document.querySelector<HTMLElement>('[data-chat-virtual-sizer]');
        return Number(sizer?.dataset.chatVirtualDataRevision ?? 0) > preStopRevision;
      }, preStopPublication.dataRevision);
    }
    const baselinePublication = await touchPublicationSnapshot(fixture.page);
    releaseEarlierPage();

    for (let frame = 0; frame < 12; frame += 1) {
      if (drag.y < drag.maximumY) await moveTranscriptTouch(fixture.page, drag, 6);
    }
    const stagedPublication = await touchPublicationSnapshot(fixture.page);
    expect(stagedPublication.entryCount).toBe(baselinePublication.entryCount);
    expect(stagedPublication.modelCount).toBe(baselinePublication.modelCount);
    expect(stagedPublication.dataRevision).toBe(baselinePublication.dataRevision);
    expect(stagedPublication.busy).toBe(true);
    await finishTranscriptTouchDrag(drag);
    drag = null;

    const publicationDeadline = Date.now() + 20_000;
    let publication: TouchPublicationSnapshot | null = null;
    while (Date.now() < publicationDeadline) {
      publication = await touchPublicationSnapshot(fixture.page);
      if (publicationReady(publication, baselinePublication, expectedEntryCount)) break;
      await fixture.page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      );
    }
    if (!publication || !publicationReady(publication, baselinePublication, expectedEntryCount)) {
      throw new Error(`Touch publication did not settle: ${JSON.stringify(publication)}`);
    }
    for (let frame = 0; frame < 6; frame += 1) {
      await fixture.page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      );
    }
    if (stopLiveTurn) {
      expect((await stopLiveTurn).outcome).toBe('interrupt-requested');
      await liveAbort;
    }
    if (liveTurnId) {
      expect((await fixture.integration.client.waitForTurnTerminal(chatId, liveTurnId)).type).toBe(
        'agent-run-finished',
      );
    }
    if (queuedPrompt) {
      const expectedQueuedPrompt = queuedPrompt;
      if (!queuePauseId) throw new Error('The paused queue lost its pause identity.');
      const control = await fixture.integration.client.getExecutionControl(chatId);
      expect(control.queue.pause?.id).toBe(queuePauseId);
      expect(control.queue.entries.map((entry) => entry.content)).toEqual([expectedQueuedPrompt]);
      expect(
        await fixture.page
          .locator(FEED_SELECTOR)
          .locator('[data-chat-row-id]')
          .filter({ hasText: expectedQueuedPrompt })
          .count(),
      ).toBe(0);
    }

    const frames = await finishReadingAnchorFrameSampler(fixture.page);
    if (queuedPrompt) {
      await fixture.integration.client.clearQueue(chatId);
      queuedPrompt = null;
    }
    const identityFailures = frames.filter(
      (frame) =>
        !frame.connected ||
        !frame.sameNode ||
        frame.offset === null ||
        frame.rowId !== anchor.rowId ||
        frame.text !== anchor.text,
    );
    const reverseMovement = frames.flatMap((frame, index) => {
      const previous = frames[index - 1];
      return previous &&
        previous.offset !== null &&
        frame.offset !== null &&
        frame.offset < previous.offset - 1
        ? [{ previous, frame }]
        : [];
    });
    expect(identityFailures, JSON.stringify({ anchor, frames }, null, 2)).toEqual([]);
    expect(reverseMovement, JSON.stringify({ anchor, frames }, null, 2)).toEqual([]);
    const firstOffset = frames.find((frame) => frame.offset !== null)?.offset;
    const finalOffset = frames.findLast((frame) => frame.offset !== null)?.offset;
    const forwardMovement =
      firstOffset != null && finalOffset != null ? finalOffset - firstOffset : 0;
    if (scenario.clampBeforeRelease) {
      expect(forwardMovement, JSON.stringify({ anchor, frames }, null, 2)).toBeLessThanOrEqual(1);
    } else {
      expect(forwardMovement, JSON.stringify({ anchor, frames }, null, 2)).toBeGreaterThan(12);
    }
    expect(earlierRequestCount).toBeGreaterThan(gestureRequestBaseline);
    fixture.assertNoBrowserErrors();
  } finally {
    releaseEarlierPage();
    if (drag) await finishTranscriptTouchDrag(drag);
    if (stopLiveTurn) await stopLiveTurn.catch(() => undefined);
    if (liveAbort) await liveAbort.catch(() => undefined);
    if (queuedPrompt) await fixture.integration.client.clearQueue(chatId).catch(() => undefined);
    liveHold?.releaseEcho();
    await fixture.page.unroute('**/api/v1/chats/messages?**');
  }
}

async function verifyPostTouchMomentumPrepend(fixture: ChromiumFixture): Promise<void> {
  await fixture.context.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      get: () =>
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) ' +
        'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    });
  });
  await fixture.page.setViewportSize({ width: 390, height: 700 });
  const chatId = await seedTranscript(fixture.integration, 90, 'chromium-touch-momentum');
  let releaseEarlierPage!: () => void;
  const earlierPageGate = new Promise<void>((resolve) => (releaseEarlierPage = resolve));
  let resolveEarlierRequest!: () => void;
  const earlierRequest = new Promise<void>((resolve) => (resolveEarlierRequest = resolve));
  let drag: TranscriptTouchDrag | null = null;

  try {
    await prepareTranscript(fixture, chatId);
    expect(await fixture.page.evaluate(() => navigator.userAgent)).toContain('iPhone');
    const initialEntryCount = await transcriptEntryCount(fixture.page);
    expect(initialEntryCount).toBe(50);
    let heldRequest = false;
    await fixture.page.route('**/api/v1/chats/messages?**', async (route) => {
      const url = new URL(route.request().url());
      if (
        !heldRequest &&
        url.searchParams.get('chatId') === chatId &&
        url.searchParams.has('beforeOrdinal')
      ) {
        heldRequest = true;
        resolveEarlierRequest();
        await earlierPageGate;
      }
      await route.continue();
    });
    await fixture.page.locator(FEED_SELECTOR).evaluate(async (feedElement) => {
      const feed = feedElement as HTMLElement;
      feed.scrollTop = Math.min(
        feed.clientHeight * 2.5,
        Math.max(0, feed.scrollHeight - feed.clientHeight),
      );
      feed.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

    drag = await beginTranscriptTouchDrag(fixture.page);
    for (let step = 0; step < 24; step += 1) {
      await moveTranscriptTouch(fixture.page, drag, 24);
      if (heldRequest) break;
    }
    await withDiagnosticTimeout('the held post-touch earlier-page request', earlierRequest);
    await finishTranscriptTouchDrag(drag);
    drag = null;

    await startTranscriptMomentum(fixture.page);
    const response = fixture.page.waitForResponse((candidate) => {
      const url = new URL(candidate.url());
      return (
        url.pathname === '/api/v1/chats/messages' &&
        url.searchParams.get('chatId') === chatId &&
        url.searchParams.has('beforeOrdinal')
      );
    });
    releaseEarlierPage();
    await (await response).finished();
    await waitForTranscriptMomentumFrames(fixture.page, 12);

    expect(await transcriptEntryCount(fixture.page)).toBe(initialEntryCount);
    expect(await fixture.page.locator(FEED_SELECTOR).getAttribute('aria-busy')).toBe('true');

    await stopTranscriptMomentum(fixture.page);
    const anchor = await readingAnchor(fixture.page);
    await startReadingAnchorFrameSampler(fixture.page, anchor);
    await waitForStableModelCount(fixture.page, initialEntryCount + 50);
    expect(await fixture.page.locator(FEED_SELECTOR).getAttribute('aria-busy')).toBe('false');
    expect((await transcriptGeometry(fixture.page)).overlaps).toEqual([]);
    expect(await mountedConversationDiscontinuities(fixture.page)).toEqual([]);
    const frames = await finishReadingAnchorFrameSampler(fixture.page);
    expect(
      frames.filter(
        (frame) =>
          !frame.connected ||
          !frame.sameNode ||
          frame.offset === null ||
          frame.rowId !== anchor.rowId ||
          frame.text !== anchor.text,
      ),
      JSON.stringify({ anchor, frames }, null, 2),
    ).toEqual([]);
    expect(
      Math.max(
        ...frames.map((frame) =>
          frame.offset === null ? Number.POSITIVE_INFINITY : Math.abs(frame.offset - anchor.offset),
        ),
      ),
      JSON.stringify({ anchor, frames }, null, 2),
    ).toBeLessThanOrEqual(1);
    fixture.assertNoBrowserErrors();
  } finally {
    releaseEarlierPage();
    await stopTranscriptMomentum(fixture.page).catch(() => undefined);
    if (drag) await finishTranscriptTouchDrag(drag);
    await fixture.page.unroute('**/api/v1/chats/messages?**');
  }
}

async function verifyNoOwnedScrollWritesDuringCoasting(fixture: ChromiumFixture): Promise<void> {
  await fixture.context.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      get: () =>
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) ' +
        'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    });
  });
  await fixture.page.setViewportSize({ width: 390, height: 700 });
  const chatId = await seedTranscript(fixture.integration, 90, 'chromium-coasting-write-gate');
  const prependChatId = await seedTranscript(fixture.integration, 90, 'chromium-coasting-prepend');
  let drag: TranscriptTouchDrag | null = null;
  let trapInstalled = false;
  let routeInstalled = false;
  let releaseEarlierPage!: () => void;
  const earlierPageGate = new Promise<void>((resolve) => (releaseEarlierPage = resolve));
  let resolveEarlierRequest!: () => void;
  const earlierRequest = new Promise<void>((resolve) => (resolveEarlierRequest = resolve));
  let earlierRequestStarted = false;
  const prompt = 'chromium-coasting-stream';
  const streaming = fixture.integration.fakeProviders.openAi.holdNext({
    lastUserText: prompt,
  });
  let turnId: string | null = null;

  try {
    await prepareTranscript(fixture, chatId);
    await scrollToPosition(fixture.page, 'end');
    await waitForStablePinnedTranscriptLayout(fixture.page, 'coasting-write-gate');
    await installTranscriptScrollTopWriteTrap(fixture.page);
    trapInstalled = true;

    drag = await beginTranscriptTouchDrag(fixture.page);
    await moveTranscriptTouch(fixture.page, drag, -24);
    expect(
      await fixture.page.locator(FEED_SELECTOR).getAttribute('data-chat-pinned-to-bottom'),
    ).toBe('true');
    await finishTranscriptTouchDrag(drag);
    drag = null;
    await startTranscriptCoastingHeartbeat(fixture.page);

    const accepted = await fixture.integration.client.runDirectChat({
      chatId,
      content: prompt,
      agent: fixture.integration.directAgents.openAi,
    });
    turnId = accepted.turnId ?? null;
    if (!turnId) throw new Error('The coasting streaming turn has no turn ID.');
    await withDiagnosticTimeout('the coasting streaming turn', streaming.received);
    const streamingText = 'Streaming content grows while coasting.';
    expect(streaming.releaseText(streamingText)).toBe(true);
    await fixture.page.getByText(streamingText, { exact: true }).waitFor();
    await waitForTranscriptCoastingFrames(fixture.page, 12);
    const followWrites = await transcriptScrollTopWrites(fixture.page);
    expect(
      followWrites.filter((write) => write.duringCoasting),
      JSON.stringify(followWrites),
    ).toEqual([]);

    await stopTranscriptCoastingHeartbeat(fixture.page);
    await fixture.page.waitForFunction(
      () => {
        const browserGlobal = globalThis as typeof globalThis & {
          __chatScrollTopWriteTrap?: { writes: TranscriptScrollTopWrite[] };
        };
        return browserGlobal.__chatScrollTopWriteTrap?.writes.some(
          (write) => !write.duringCoasting,
        );
      },
      undefined,
      { timeout: 20_000 },
    );
    streaming.releaseEcho();
    expect((await fixture.integration.client.waitForTurnTerminal(chatId, turnId)).type).toBe(
      'agent-run-finished',
    );
    await waitForStablePinnedTranscriptLayout(fixture.page, 'coasting-stream-settled');
    await uninstallTranscriptScrollTopWriteTrap(fixture.page);
    trapInstalled = false;

    await prepareTranscript(fixture, prependChatId);

    await fixture.page.route('**/api/v1/chats/messages?**', async (route) => {
      const url = new URL(route.request().url());
      if (
        !earlierRequestStarted &&
        url.searchParams.get('chatId') === prependChatId &&
        url.searchParams.has('beforeOrdinal')
      ) {
        earlierRequestStarted = true;
        resolveEarlierRequest();
        await earlierPageGate;
      }
      await route.continue();
    });
    routeInstalled = true;
    await fixture.page.locator(FEED_SELECTOR).evaluate(async (feedElement) => {
      const feed = feedElement as HTMLElement;
      feed.scrollTop = Math.min(
        feed.clientHeight * 2.5,
        Math.max(0, feed.scrollHeight - feed.clientHeight),
      );
      feed.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

    drag = await beginTranscriptTouchDrag(fixture.page);
    for (let step = 0; step < 24; step += 1) {
      await moveTranscriptTouch(fixture.page, drag, 24);
      if (earlierRequestStarted) break;
    }
    await withDiagnosticTimeout('the coasting earlier-page request', earlierRequest);
    const entryCountBeforePrepend = await transcriptEntryCount(fixture.page);
    await installTranscriptScrollTopWriteTrap(fixture.page);
    trapInstalled = true;
    await finishTranscriptTouchDrag(drag);
    drag = null;
    await startTranscriptCoastingHeartbeat(fixture.page);
    const response = fixture.page.waitForResponse((candidate) => {
      const url = new URL(candidate.url());
      return (
        url.pathname === '/api/v1/chats/messages' &&
        url.searchParams.get('chatId') === prependChatId &&
        url.searchParams.has('beforeOrdinal')
      );
    });
    releaseEarlierPage();
    await (await response).finished();
    await waitForTranscriptCoastingFrames(fixture.page, 12);
    expect(await transcriptEntryCount(fixture.page)).toBe(entryCountBeforePrepend);
    const prependWrites = await transcriptScrollTopWrites(fixture.page);
    expect(
      prependWrites.filter((write) => write.duringCoasting),
      JSON.stringify(prependWrites),
    ).toEqual([]);

    await stopTranscriptCoastingHeartbeat(fixture.page);
    expect(await waitForTranscriptEntryCount(fixture.page, entryCountBeforePrepend + 50)).toBe(
      entryCountBeforePrepend + 50,
    );
    await waitForTranscriptReady(fixture.page);
    await fixture.page.waitForFunction(
      () => {
        const browserGlobal = globalThis as typeof globalThis & {
          __chatScrollTopWriteTrap?: { writes: TranscriptScrollTopWrite[] };
        };
        return browserGlobal.__chatScrollTopWriteTrap?.writes.some(
          (write) => !write.duringCoasting,
        );
      },
      undefined,
      { timeout: 20_000 },
    );
    fixture.assertNoBrowserErrors();
  } finally {
    releaseEarlierPage();
    streaming.releaseEcho();
    if (drag) await finishTranscriptTouchDrag(drag);
    if (trapInstalled) await uninstallTranscriptScrollTopWriteTrap(fixture.page);
    if (routeInstalled) await fixture.page.unroute('**/api/v1/chats/messages?**');
  }
}

async function verifyScrollbarDragPrepend(
  fixture: ChromiumFixture,
  viewport: { height: number; width: number },
): Promise<void> {
  await fixture.page.setViewportSize(viewport);
  const chatId = await seedTranscript(
    fixture.integration,
    90,
    `chromium-scrollbar-${viewport.width}`,
  );
  let releaseEarlierPage!: () => void;
  const earlierPageGate = new Promise<void>((resolve) => (releaseEarlierPage = resolve));
  let resolveEarlierRequest!: () => void;
  const earlierRequest = new Promise<void>((resolve) => (resolveEarlierRequest = resolve));
  let earlierRequestCount = 0;
  let dragRequestBaseline = 0;
  let mouseDown = false;

  try {
    const { initialModelCount } = await prepareTranscript(fixture, chatId);
    dragRequestBaseline = earlierRequestCount;
    await fixture.page.route('**/api/v1/chats/messages?**', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('chatId') === chatId && url.searchParams.has('beforeOrdinal')) {
        earlierRequestCount += 1;
        if (earlierRequestCount === dragRequestBaseline + 1) {
          resolveEarlierRequest();
          await earlierPageGate;
        }
      }
      await route.continue();
    });
    await scrollToPosition(fixture.page, 'middle');
    const scrollbar = fixture.page.locator('[data-chat-feed-scrollbar]');
    const thumb = scrollbar.locator('[data-slot="scroll-area-thumb"]');
    const trackBox = await scrollbar.boundingBox();
    const thumbBox = await thumb.boundingBox();
    if (!trackBox || !thumbBox) throw new Error('The transcript scrollbar is not measurable.');

    const x = thumbBox.x + thumbBox.width / 2;
    let y = thumbBox.y + thumbBox.height / 2;
    await fixture.page.mouse.move(x, y);
    await fixture.page.mouse.down();
    mouseDown = true;
    for (let step = 0; step < 24; step += 1) {
      y = Math.max(trackBox.y + 4, y - Math.max(4, trackBox.height / 24));
      await fixture.page.mouse.move(x, y);
      if (earlierRequestCount > dragRequestBaseline) break;
    }
    await withDiagnosticTimeout('the held scrollbar-drag earlier page', earlierRequest);
    const upwardScrollTop = await fixture.page
      .locator(FEED_SELECTOR)
      .evaluate((feedElement) => (feedElement as HTMLElement).scrollTop);

    const reversalY = Math.min(trackBox.y + trackBox.height - 4, y + trackBox.height / 8);
    await fixture.page.mouse.move(x, reversalY, { steps: 6 });
    const reversedScrollTop = await fixture.page
      .locator(FEED_SELECTOR)
      .evaluate((feedElement) => (feedElement as HTMLElement).scrollTop);
    expect(reversedScrollTop).toBeGreaterThan(upwardScrollTop);

    const anchor = await readingAnchor(fixture.page);
    await startReadingAnchorFrameSampler(fixture.page, anchor);
    releaseEarlierPage();
    await waitForStableModelCount(fixture.page, initialModelCount + 50);
    const frames = await finishReadingAnchorFrameSampler(fixture.page);
    expect(
      frames.filter(
        (frame) =>
          !frame.connected ||
          !frame.sameNode ||
          frame.offset === null ||
          frame.rowId !== anchor.rowId ||
          frame.text !== anchor.text,
      ),
      JSON.stringify({ anchor, frames, upwardScrollTop, reversedScrollTop }, null, 2),
    ).toEqual([]);
    expect(
      Math.max(
        ...frames.map((frame) =>
          frame.offset === null ? Number.POSITIVE_INFINITY : Math.abs(frame.offset - anchor.offset),
        ),
      ),
      JSON.stringify({ anchor, frames, upwardScrollTop, reversedScrollTop }, null, 2),
    ).toBeLessThanOrEqual(1);
    expect(earlierRequestCount).toBeGreaterThan(dragRequestBaseline);
    fixture.assertNoBrowserErrors();
  } finally {
    releaseEarlierPage();
    if (mouseDown) await fixture.page.mouse.up().catch(() => undefined);
    await fixture.page.unroute('**/api/v1/chats/messages?**');
  }
}

async function verifyKeyboardPrepend(
  fixture: ChromiumFixture,
  viewport: { height: number; width: number },
): Promise<void> {
  await fixture.page.setViewportSize(viewport);
  const chatId = await seedTranscript(
    fixture.integration,
    90,
    `chromium-keyboard-${viewport.width}`,
  );
  let releaseEarlierPage!: () => void;
  const earlierPageGate = new Promise<void>((resolve) => (releaseEarlierPage = resolve));
  let resolveEarlierRequest!: () => void;
  const earlierRequest = new Promise<void>((resolve) => (resolveEarlierRequest = resolve));
  let earlierRequestCount = 0;
  let keyboardRequestBaseline = 0;

  try {
    const { initialModelCount } = await prepareTranscript(fixture, chatId);
    keyboardRequestBaseline = earlierRequestCount;
    await fixture.page.route('**/api/v1/chats/messages?**', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('chatId') === chatId && url.searchParams.has('beforeOrdinal')) {
        earlierRequestCount += 1;
        if (earlierRequestCount === keyboardRequestBaseline + 1) {
          resolveEarlierRequest();
          await earlierPageGate;
        }
      }
      await route.continue();
    });
    await fixture.page.locator(FEED_SELECTOR).evaluate(async (feedElement) => {
      const feed = feedElement as HTMLElement;
      const maximum = Math.max(0, feed.scrollHeight - feed.clientHeight);
      feed.scrollTop = Math.min(maximum, feed.clientHeight * 2.5);
      feed.dispatchEvent(new Event('scroll', { bubbles: true }));
      feed.focus({ preventScroll: true });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

    for (let press = 0; press < 24; press += 1) {
      await fixture.page.keyboard.press('PageUp');
      await fixture.page.evaluate(async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });
      if (earlierRequestCount > keyboardRequestBaseline) break;
    }
    await withDiagnosticTimeout('the held keyboard earlier page', earlierRequest);
    await fixture.page.locator(FEED_SELECTOR).evaluate(async (feedElement) => {
      const feed = feedElement as HTMLElement;
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      let previous = feed.scrollTop;
      let stableFrames = 0;
      for (let attempt = 0; attempt < 90; attempt += 1) {
        await frame();
        const current = feed.scrollTop;
        stableFrames = Math.abs(current - previous) <= 0.5 ? stableFrames + 1 : 0;
        previous = current;
        if (stableFrames >= 7) return;
      }
      throw new Error('Keyboard transcript paging did not settle before publication.');
    });
    expect(await fixture.page.locator('[data-transcript-page-boundary="earlier"]').count()).toBe(0);

    const anchor = await readingAnchor(fixture.page);
    await startReadingAnchorFrameSampler(fixture.page, anchor);
    releaseEarlierPage();
    await waitForStableModelCount(fixture.page, initialModelCount + 50);
    const frames = await finishReadingAnchorFrameSampler(fixture.page);
    expect(
      frames.filter(
        (frame) =>
          !frame.connected ||
          !frame.sameNode ||
          frame.offset === null ||
          frame.rowId !== anchor.rowId ||
          frame.text !== anchor.text,
      ),
      JSON.stringify({ anchor, frames }, null, 2),
    ).toEqual([]);
    expect(
      Math.max(
        ...frames.map((frame) =>
          frame.offset === null ? Number.POSITIVE_INFINITY : Math.abs(frame.offset - anchor.offset),
        ),
      ),
      JSON.stringify({ anchor, frames }, null, 2),
    ).toBeLessThanOrEqual(1);
    expect(earlierRequestCount).toBeGreaterThan(keyboardRequestBaseline);
    fixture.assertNoBrowserErrors();
  } finally {
    releaseEarlierPage();
    await fixture.page.unroute('**/api/v1/chats/messages?**');
  }
}

async function prepareTranscript(
  fixture: ChromiumFixture,
  chatId: string,
  minimumModelCount = 50,
): Promise<{
  chatId: string;
  initialModelCount: number;
}> {
  return withDiagnosticTimeout(
    'the transcript fixture to be prepared',
    (async () => {
      const response = await fixture.page.goto(
        `${fixture.integration.garcon.baseUrl}/chat/${encodeURIComponent(chatId)}`,
        { waitUntil: 'domcontentloaded' },
      );
      if (!response?.ok()) throw new Error(`SPA navigation failed with ${response?.status()}.`);

      await waitForTranscriptReady(fixture.page);
      return {
        chatId,
        initialModelCount: await waitForStableModelCount(fixture.page, minimumModelCount),
      };
    })(),
    45_000,
  );
}

async function revealEarlierTranscript(
  page: Page,
  initialModelCount: number,
): Promise<{ anchor: ReadingAnchor; frames: ReadingAnchorFrameSample[] }> {
  return withDiagnosticTimeout(
    'the earlier transcript page to be revealed',
    (async () => {
      await scrollToPosition(page, 'middle');
      await signalScrollIntent(page, 'later');
      const prefetchPosition = await page.locator(FEED_SELECTOR).evaluate(async (feedElement) => {
        const feed = feedElement as HTMLElement;
        const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const attempts: Array<{
          maximum: number;
          target: number;
          scrollTop: number;
        }> = [];
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const maximum = Math.max(0, feed.scrollHeight - feed.clientHeight);
          const target = Math.min(maximum, Math.max(101, feed.clientHeight * 0.75));
          feed.scrollTop = target;
          feed.dispatchEvent(new Event('scroll', { bubbles: true }));
          await settle();
          await settle();
          attempts.push({ maximum, target, scrollTop: feed.scrollTop });
          // First measurements may correct the offset; the anchor sampler starts after they settle.
          if (feed.scrollTop > 100 && feed.scrollTop <= feed.clientHeight) {
            return {
              attempts,
              scrollTop: feed.scrollTop,
              viewportHeight: feed.clientHeight,
            };
          }
        }
        throw new Error(
          `The earlier prefetch position did not settle: ${JSON.stringify(attempts)}`,
        );
      });
      expect(prefetchPosition.scrollTop, JSON.stringify(prefetchPosition)).toBeGreaterThan(100);
      expect(prefetchPosition.scrollTop).toBeLessThanOrEqual(prefetchPosition.viewportHeight);
      const anchor = await readingAnchor(page);
      await startReadingAnchorFrameSampler(page, anchor);
      const previousRevision = await virtualDataRevision(page);
      await signalScrollIntent(page, 'earlier');
      await page.locator(FEED_SELECTOR).dispatchEvent('scroll');
      await waitForVirtualDataRevisionAfter(page, previousRevision);
      await waitForModelCount(page, initialModelCount + 1);
      return { anchor, frames: await finishReadingAnchorFrameSampler(page) };
    })(),
  );
}

async function verifyBoundedPrepend(fixture: ChromiumFixture, chatId: string): Promise<void> {
  const { initialModelCount } = await prepareTranscript(fixture, chatId);
  await scrollToPosition(fixture.page, 'end');
  await waitForDistanceFromEnd(fixture.page, 1);
  await verifyDetachedNearEndGrowth(fixture.page);
  const { anchor: prependAnchor, frames: prependFrames } = await revealEarlierTranscript(
    fixture.page,
    initialModelCount,
  );
  const restoredPrependAnchor = await anchorByKey(fixture.page, prependAnchor.key);
  expect(prependFrames.length).toBeGreaterThan(2);
  expect(
    Math.max(
      ...prependFrames.map((sample) =>
        sample.offset === null
          ? Number.POSITIVE_INFINITY
          : Math.abs(sample.offset - prependAnchor.offset),
      ),
    ),
    JSON.stringify({ prependAnchor, prependFrames }, null, 2),
  ).toBeLessThanOrEqual(1);
  expect(Math.abs(restoredPrependAnchor.offset - prependAnchor.offset)).toBeLessThanOrEqual(1);

  const expandedGeometry = await transcriptGeometry(fixture.page);
  expect(expandedGeometry.modelCount).toBeGreaterThanOrEqual(100);
  expect(expandedGeometry.transcriptItemCount).toBeGreaterThan(0);
  expect(expandedGeometry.itemCount).toBeLessThan(60);
  expect(expandedGeometry.overlaps).toEqual([]);
  expect(expandedGeometry.horizontalOverflow).toEqual([]);
  fixture.assertNoBrowserErrors();
}

async function verifyGrowingNavigation(fixture: ChromiumFixture, chatId: string): Promise<void> {
  const { initialModelCount } = await prepareTranscript(fixture, chatId);
  await revealEarlierTranscript(fixture.page, initialModelCount);
  await selectAndVerifyNavigatorTarget(fixture.page, 'chromium-virtual-turn-45');
  await selectAndVerifyDelayedNavigatorTarget(fixture.page, 'chromium-virtual-turn-38');
  fixture.assertNoBrowserErrors();
}

async function verifySelectionRetention(fixture: ChromiumFixture, chatId: string): Promise<void> {
  const { initialModelCount } = await prepareTranscript(fixture, chatId);
  await revealEarlierTranscript(fixture.page, initialModelCount);
  await scrollToPosition(fixture.page, 'middle');
  const selected = await selectVisibleMessageText(fixture.page);
  await fixture.page.waitForFunction(
    ({ itemSelector, key, expectedText }) => {
      const selection = document.getSelection();
      return (
        selection?.toString() === expectedText &&
        [...document.querySelectorAll<HTMLElement>(itemSelector)].some(
          (item) => item.dataset.chatVirtualItem === key,
        )
      );
    },
    {
      itemSelector: ITEM_SELECTOR,
      key: selected.key,
      expectedText: selected.text,
    },
  );

  await scrollToPosition(fixture.page, selected.scrollTarget);
  const retained = await fixture.page.evaluate(
    ({ feedSelector, itemSelector, key, rowId }) => {
      const feed = document.querySelector<HTMLElement>(feedSelector);
      const wrapper = [...document.querySelectorAll<HTMLElement>(itemSelector)].find(
        (item) => item.dataset.chatVirtualItem === key,
      );
      const row = wrapper?.querySelector<HTMLElement>('[data-chat-row-id]');
      const selection = document.getSelection();
      if (!feed || !wrapper || !row || !selection) return null;
      if (row.dataset.chatRowId !== rowId) return null;
      const viewport = feed.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      return {
        rowId: row.dataset.chatRowId,
        text: selection.toString(),
        outsideViewport: rowRect.bottom < viewport.top || rowRect.top > viewport.bottom,
      };
    },
    {
      feedSelector: FEED_SELECTOR,
      itemSelector: ITEM_SELECTOR,
      key: selected.key,
      rowId: selected.rowId,
    },
  );
  expect(retained).toEqual({
    rowId: selected.rowId,
    text: selected.text,
    outsideViewport: true,
  });
  await releaseBrowserSelection(fixture.page);
  await fixture.page.waitForFunction(
    ({ itemSelector, key }) =>
      ![...document.querySelectorAll<HTMLElement>(itemSelector)].some(
        (item) => item.dataset.chatVirtualItem === key,
      ),
    { itemSelector: ITEM_SELECTOR, key: selected.key },
  );
  fixture.assertNoBrowserErrors();
}

async function verifyLaterPageReadingPosition(
  fixture: ChromiumFixture,
  chatId: string,
): Promise<void> {
  await prepareTranscript(fixture, chatId);
  await scrollToPosition(fixture.page, 'middle');
  const initialPrompt = fixture.page.locator('button[title="Scroll to initial prompt"]');
  await initialPrompt.waitFor({ state: 'visible' });
  const initialWindowRevision = await virtualDataRevision(fixture.page);
  await initialPrompt.click();
  await waitForVirtualDataRevisionAfter(fixture.page, initialWindowRevision);
  await waitForTranscriptReady(fixture.page);
  await initialPrompt.waitFor({ state: 'hidden' });

  await signalScrollIntent(fixture.page, 'earlier');
  const prefetchPosition = await positionNearLaterPageBoundary(fixture.page);
  expect(prefetchPosition.distanceFromEnd).toBeGreaterThan(50);
  expect(prefetchPosition.distanceFromEnd).toBeLessThanOrEqual(prefetchPosition.viewportHeight);
  const anchor = await readingAnchor(fixture.page);
  const previousRevision = await virtualDataRevision(fixture.page);
  await signalScrollIntent(fixture.page, 'later');
  await fixture.page.locator(FEED_SELECTOR).dispatchEvent('scroll');
  await waitForVirtualDataRevisionAfter(fixture.page, previousRevision);
  const restored = await anchorByKey(fixture.page, anchor.key);
  expect(
    Math.abs(restored.offset - anchor.offset),
    JSON.stringify({ anchor, restored }),
  ).toBeLessThanOrEqual(1);
  expect(await viewportPolicy(fixture.page)).toEqual({
    pinned: false,
    userScrolledUp: true,
  });

  const returnToLatest = fixture.page.locator('button[title="Scroll to bottom"]');
  await returnToLatest.waitFor({ state: 'visible' });
  let releaseLatestRequest!: () => void;
  const latestRequestGate = new Promise<void>((resolve) => (releaseLatestRequest = resolve));
  let resolveLatestRequestStarted!: () => void;
  const latestRequestStarted = new Promise<void>(
    (resolve) => (resolveLatestRequestStarted = resolve),
  );
  let heldLatestRequest = false;
  await fixture.page.route('**/api/v1/chats/messages?**', async (route) => {
    const url = new URL(route.request().url());
    if (
      !heldLatestRequest &&
      url.searchParams.get('chatId') === chatId &&
      !url.searchParams.has('beforeOrdinal')
    ) {
      heldLatestRequest = true;
      resolveLatestRequestStarted();
      await latestRequestGate;
    }
    await route.continue();
  });
  try {
    const latestWindowRevision = await virtualDataRevision(fixture.page);
    await returnToLatest.click();
    await withDiagnosticTimeout('the held latest-window request', latestRequestStarted);
    await returnToLatest.locator('svg.animate-spin').waitFor({ state: 'visible' });
    releaseLatestRequest();
    await waitForVirtualDataRevisionAfter(fixture.page, latestWindowRevision);
  } finally {
    releaseLatestRequest();
    await fixture.page.unroute('**/api/v1/chats/messages?**');
  }
  await waitForStablePinnedTranscriptLayout(fixture.page, 'return-to-latest');
  await appendTurn(fixture.integration, chatId, 'chromium-later-window-live-append');
  await fixture.page
    .locator(FEED_SELECTOR)
    .getByText('echo:chromium-later-window-live-append', { exact: true })
    .waitFor();
  await waitForStablePinnedTranscriptLayout(fixture.page, 'live-append-after-return');
  fixture.assertNoBrowserErrors();
}

async function positionNearLaterPageBoundary(
  page: Page,
): Promise<{ distanceFromEnd: number; viewportHeight: number }> {
  return page.locator(FEED_SELECTOR).evaluate(async (feedElement) => {
    const feed = feedElement as HTMLElement;
    const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const targetDistance = Math.max(51, feed.clientHeight * 0.75);
    let stableFrames = 0;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const maximum = Math.max(0, feed.scrollHeight - feed.clientHeight);
      if (maximum > targetDistance) {
        feed.scrollTop = maximum - targetDistance;
        feed.dispatchEvent(new Event('scroll', { bubbles: true }));
      }
      await settle();
      const distanceFromEnd = feed.scrollHeight - feed.clientHeight - feed.scrollTop;
      stableFrames = Math.abs(distanceFromEnd - targetDistance) <= 1 ? stableFrames + 1 : 0;
      if (stableFrames >= 4) {
        return { distanceFromEnd, viewportHeight: feed.clientHeight };
      }
    }
    throw new Error('The later-page prefetch position did not settle.');
  });
}

async function verifyConcurrentAppendNavigation(
  fixture: ChromiumFixture,
  chatId: string,
): Promise<void> {
  const { initialModelCount } = await prepareTranscript(fixture, chatId);
  await revealEarlierTranscript(fixture.page, initialModelCount);
  await selectNavigatorTargetDuringAppend(fixture, chatId, 'chromium-virtual-turn-36');
  fixture.assertNoBrowserErrors();
}

async function verifyEdgeNavigation(fixture: ChromiumFixture, chatId: string): Promise<void> {
  const { initialModelCount } = await prepareTranscript(fixture, chatId);
  await revealEarlierTranscript(fixture.page, initialModelCount);
  await withDiagnosticTimeout(
    'the start-edge navigator target',
    selectAndVerifyEdgeNavigatorTarget(fixture.page, 'chromium-virtual-turn-0', 'start'),
    30_000,
  );
  await withDiagnosticTimeout(
    'the end-edge navigator target',
    selectAndVerifyEdgeNavigatorTarget(fixture.page, 'chromium-generation-prime', 'end'),
    30_000,
  );
  fixture.assertNoBrowserErrors();
}

async function verifyTargetCancellation(fixture: ChromiumFixture, chatId: string): Promise<void> {
  const { initialModelCount } = await prepareTranscript(fixture, chatId);
  await revealEarlierTranscript(fixture.page, initialModelCount);
  await withDiagnosticTimeout(
    'the growing navigator target cancellation',
    interruptNavigatorJump(fixture.page, 'chromium-virtual-turn-40'),
    30_000,
  );
  fixture.assertNoBrowserErrors();
}

async function verifyAppendGeometry(fixture: ChromiumFixture, chatId: string): Promise<void> {
  await prepareTranscript(fixture, chatId);

  await scrollToPosition(fixture.page, 'middle');
  const detachedAnchor = await readingAnchor(fixture.page);
  await startReadingAnchorFrameSampler(fixture.page, detachedAnchor);
  await appendTurn(fixture.integration, chatId, 'chromium-detached-append');
  await fixture.page.getByRole('status').filter({ hasText: 'New response available' }).waitFor();
  const restoredDetachedAnchor = await anchorByKey(fixture.page, detachedAnchor.key);
  const detachedAppendFrames = await finishReadingAnchorFrameSampler(fixture.page);
  expect(detachedAppendFrames.length).toBeGreaterThan(2);
  expect(
    detachedAppendFrames.filter((sample) => sample.offset === null),
    JSON.stringify({ detachedAnchor, detachedAppendFrames }, null, 2),
  ).toEqual([]);
  expect(
    Math.max(
      ...detachedAppendFrames.map((sample) =>
        sample.offset === null
          ? Number.POSITIVE_INFINITY
          : Math.abs(sample.offset - detachedAnchor.offset),
      ),
    ),
    JSON.stringify({ detachedAnchor, detachedAppendFrames }, null, 2),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(restoredDetachedAnchor.offset - detachedAnchor.offset),
    JSON.stringify({ detachedAnchor, restoredDetachedAnchor }),
  ).toBeLessThanOrEqual(1);
  expect((await transcriptGeometry(fixture.page)).distanceFromEnd).toBeGreaterThan(1);

  const hiddenAnchor = await readingAnchor(fixture.page);
  expect(await viewportPolicy(fixture.page)).toEqual({
    pinned: false,
    userScrolledUp: true,
  });
  const chatIdentity = await currentWorkspaceIdentity(fixture.page);
  await openCurrentWorkspaceAddMenu(fixture.page);
  await clickMenuItem(fixture.page, 'New Terminal');
  await fixture.page.locator(FEED_SELECTOR).waitFor({ state: 'hidden' });
  await appendTurn(fixture.integration, chatId, 'chromium-hidden-append');
  await selectWorkspaceWindowSurface(fixture.page, chatIdentity.windowId, chatIdentity.surfaceId);
  await waitForTranscriptReady(fixture.page);
  expect(await viewportPolicy(fixture.page)).toEqual({
    pinned: false,
    userScrolledUp: true,
  });
  const restoredHiddenAnchor = await anchorByKey(fixture.page, hiddenAnchor.key);
  expect(
    Math.abs(restoredHiddenAnchor.offset - hiddenAnchor.offset),
    JSON.stringify({ hiddenAnchor, restoredHiddenAnchor }),
  ).toBeLessThanOrEqual(1);

  await scrollToPosition(fixture.page, 'end');
  await appendTurn(fixture.integration, chatId, 'chromium-pinned-append');
  await fixture.page
    .locator(FEED_SELECTOR)
    .getByText('echo:chromium-pinned-append', { exact: true })
    .waitFor();
  await waitForStablePinnedTranscriptLayout(fixture.page, 'pinned-append');

  const pinnedIdentity = await currentWorkspaceIdentity(fixture.page);
  await openCurrentWorkspaceAddMenu(fixture.page);
  await clickMenuItem(fixture.page, 'New Terminal');
  await fixture.page.locator(FEED_SELECTOR).waitFor({ state: 'hidden' });
  await appendTurn(fixture.integration, chatId, 'chromium-pinned-hidden-append');
  await selectWorkspaceWindowSurface(
    fixture.page,
    pinnedIdentity.windowId,
    pinnedIdentity.surfaceId,
  );
  await fixture.page
    .locator(FEED_SELECTOR)
    .getByText('echo:chromium-pinned-hidden-append', { exact: true })
    .waitFor();
  await waitForStablePinnedTranscriptLayout(fixture.page, 'pinned-hidden-append-show');
  fixture.assertNoBrowserErrors();
}

// Samples every frame across a chat switch and rejects visible end drift, paint-gate
// leaks, and post-reveal changes to the visible virtual row geometry.
async function expectNoSwitchPaintFlicker(
  fixture: ChromiumFixture,
  switchAction: () => Promise<void>,
): Promise<void> {
  const samples = fixture.page.locator(FEED_SELECTOR).evaluate(async (feedElement) => {
    const feed = feedElement as HTMLElement;
    const browserGlobal = globalThis as typeof globalThis & {
      __chatSwitchPaintSamplerReady?: boolean;
    };
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const surfaceOf = (): string => {
      const item = feed.querySelector<HTMLElement>('[data-chat-virtual-item]');
      const value = item?.dataset.chatVirtualItem;
      if (!value) return '';
      try {
        const parsed = JSON.parse(value) as unknown;
        return Array.isArray(parsed) && typeof parsed[0] === 'string' ? parsed[0] : '';
      } catch {
        return '';
      }
    };
    const initialSurface = surfaceOf();
    browserGlobal.__chatSwitchPaintSamplerReady = true;
    const violations: Array<Record<string, unknown>> = [];
    const transition: Array<Record<string, unknown>> = [];
    const visibleItemGeometry = () => {
      const feedRect = feed.getBoundingClientRect();
      return [...feed.querySelectorAll<HTMLElement>('[data-chat-virtual-item]')].flatMap((item) => {
        const rect = item.getBoundingClientRect();
        if (rect.bottom <= feedRect.top + 1 || rect.top >= feedRect.bottom - 1) return [];
        return [
          {
            key: item.dataset.chatVirtualItem ?? '',
            top: rect.top - feedRect.top,
            height: rect.height,
          },
        ];
      });
    };
    let switchObserved = false;
    let settledFrames = 0;
    let violationCount = 0;
    const beforeSwitch: Array<Record<string, unknown>> = [];
    let settledGeometry: ReturnType<typeof visibleItemGeometry> | null = null;
    for (let attempt = 0; attempt < 600 && settledFrames < 12; attempt += 1) {
      await frame();
      const content = feed.querySelector<HTMLElement>('[data-chat-feed-content]');
      if (!content) continue;
      const rowCount = content.querySelectorAll('[data-chat-virtual-item]').length;
      const busy = feed.getAttribute('aria-busy') === 'true';
      const contentVisible = getComputedStyle(content).visibility !== 'hidden';
      const scrollbar = [
        ...document.querySelectorAll<HTMLElement>('[data-chat-feed-scrollbar]'),
      ].find((candidate) => candidate.parentElement?.contains(feed));
      const scrollbarVisible = Boolean(
        scrollbar && scrollbar.isConnected && getComputedStyle(scrollbar).visibility !== 'hidden',
      );
      const distanceFromEnd = feed.scrollHeight - feed.clientHeight - feed.scrollTop;
      const currentSurface = surfaceOf();
      if (currentSurface && currentSurface !== initialSurface) switchObserved = true;
      const sizer = feed.querySelector<HTMLElement>('[data-chat-virtual-sizer]');
      const sample = {
        attempt,
        busy,
        contentVisible,
        scrollbarVisible,
        distanceFromEnd,
        scrollTop: feed.scrollTop,
        scrollHeight: feed.scrollHeight,
        clientHeight: feed.clientHeight,
        rowCount,
        modelCount: Number(sizer?.dataset.chatVirtualModelCount ?? 0),
        totalSize: Number.parseFloat(sizer?.style.height ?? '0'),
        pinned: feed.dataset.chatPinnedToBottom,
        userScrolledUp: feed.dataset.chatUserScrolledUp,
        surface: currentSurface,
        path: location.pathname,
      };
      if (!switchObserved) {
        beforeSwitch.push(sample);
        if (beforeSwitch.length > 12) beforeSwitch.shift();
        continue;
      }
      if (transition.length === 0) transition.push(...beforeSwitch);
      if (transition.length < 36) transition.push(sample);
      const recordViolation = (violation: Record<string, unknown>): void => {
        violationCount += 1;
        if (violations.length < 12) violations.push(violation);
      };
      if (!contentVisible && scrollbarVisible) {
        recordViolation({ ...sample, kind: 'paint-gate-scrollbar-visible' });
      } else if (contentVisible && rowCount > 0 && Math.abs(distanceFromEnd) > 2) {
        recordViolation({ ...sample, kind: 'visible-end-drift' });
      }
      const settled = contentVisible && rowCount > 0 && Math.abs(distanceFromEnd) <= 1;
      if (settled) {
        const currentGeometry = visibleItemGeometry();
        if (settledGeometry) {
          const changed =
            currentGeometry.length !== settledGeometry.length ||
            currentGeometry.some((item, index) => {
              const previous = settledGeometry?.[index];
              return (
                !previous ||
                item.key !== previous.key ||
                Math.abs(item.top - previous.top) > 1 ||
                Math.abs(item.height - previous.height) > 1
              );
            });
          if (changed) {
            recordViolation({
              attempt,
              kind: 'settled-visible-geometry-changed',
              previous: settledGeometry,
              current: currentGeometry,
            });
          }
        } else {
          settledGeometry = currentGeometry;
        }
      } else if (settledGeometry) {
        recordViolation({
          attempt,
          kind: 'settled-feed-became-unsettled',
          busy,
          contentVisible,
        });
      }
      settledFrames = settled ? settledFrames + 1 : 0;
    }
    delete browserGlobal.__chatSwitchPaintSamplerReady;
    return {
      settledFrames,
      switchObserved,
      transition,
      violationCount,
      violations,
    };
  });
  await fixture.page.waitForFunction(
    () =>
      Boolean(
        (
          globalThis as typeof globalThis & {
            __chatSwitchPaintSamplerReady?: boolean;
          }
        ).__chatSwitchPaintSamplerReady,
      ),
    undefined,
    { timeout: 5_000 },
  );
  await switchAction();
  const observed = await withDiagnosticTimeout('the switch paint samples', samples, 30_000);
  expect(observed.violationCount, JSON.stringify(observed, null, 2)).toBe(0);
  expect(observed.switchObserved, JSON.stringify(observed, null, 2)).toBe(true);
  expect(observed.settledFrames, JSON.stringify(observed, null, 2)).toBeGreaterThanOrEqual(12);
}

function heterogeneousAssistantResponse(index: number): string {
  const paragraphs = Array.from(
    { length: (index % 4) + 1 },
    (_, paragraph) =>
      `Paragraph ${paragraph + 1} for response ${index} exercises variable-height Markdown during chat restoration.`,
  ).join('\n\n');
  const code =
    index % 2 === 0
      ? `\n\n\`\`\`ts\nconst restoredRow${index} = { index: ${index}, stable: true };\nconsole.log(restoredRow${index});\n\`\`\``
      : '';
  return `## Heterogeneous response ${index}\n\n${paragraphs}${code}`;
}

async function seedHeterogeneousTranscript(
  fixture: ChromiumFixture,
  environment: ScriptedClaudeTestEnvironment,
): Promise<string> {
  const chatId = fixture.integration.newChatId();
  for (let index = 0; index < 9; index += 1) {
    const toolOutput = Array.from(
      { length: (index % 4) + 1 },
      (_, line) => `heterogeneous-tool-${index}-line-${line + 1}`,
    ).join('\\n');
    environment.model.scriptTurn([
      claudeToolUse(`toolu_chromium_switch_${index}`, 'Bash', {
        command: `printf '%b' '${toolOutput}\\n'`,
      }),
    ]);
    environment.model.scriptTurn([claudeText(heterogeneousAssistantResponse(index))]);
    const accepted =
      index === 0
        ? await fixture.integration.client.startChat(
            liveClaudeStartRequest({
              chatId,
              projectPath: fixture.integration.dirs.project,
              command: `chromium-heterogeneous-switch-${index}`,
              permissionMode: 'bypassPermissions',
            }),
          )
        : await fixture.integration.client.runChat(
            liveClaudeRunRequest({
              chatId,
              command: `chromium-heterogeneous-switch-${index}`,
              permissionMode: 'bypassPermissions',
            }),
          );
    expect(
      (await fixture.integration.client.waitForTurnTerminal(chatId, accepted.turnId)).type,
    ).toBe('agent-run-finished');
  }
  environment.model.assertSettled();
  return chatId;
}

async function verifyChatSwitchBottomRestore(
  fixture: ChromiumFixture,
  primaryChatId: string,
  environment: ScriptedClaudeTestEnvironment,
): Promise<void> {
  const secondaryMarker = 'chromium-heterogeneous-switch-0';
  const secondaryChatId = await seedHeterogeneousTranscript(fixture, environment);
  // The scripted start can select its newly created chat. Re-establishes the primary
  // surface before sampling the actual sidebar switch in either direction.
  await prepareTranscript(fixture, primaryChatId);
  await scrollToPosition(fixture.page, 'end');
  await waitForDistanceFromEnd(fixture.page, 1);

  await expectNoSwitchPaintFlicker(fixture, () =>
    selectSidebarChat(fixture.page, secondaryChatId, secondaryMarker),
  );
  await waitForStablePinnedTranscriptLayout(fixture.page, 'switch-to-secondary');
  const visibleHeights = await fixture.page
    .locator(ITEM_SELECTOR)
    .evaluateAll((items) =>
      items.map((item) => Math.round((item as HTMLElement).getBoundingClientRect().height)),
    );
  expect(new Set(visibleHeights).size, JSON.stringify(visibleHeights)).toBeGreaterThanOrEqual(3);

  await expectNoSwitchPaintFlicker(fixture, () =>
    selectSidebarChat(fixture.page, primaryChatId, 'chromium-virtual-turn-0'),
  );
  await waitForStablePinnedTranscriptLayout(fixture.page, 'switch-back-to-primary');
  expect(await viewportPolicy(fixture.page)).toEqual({
    pinned: true,
    userScrolledUp: false,
  });
  fixture.assertNoBrowserErrors();
}

async function verifyHeldEarlierPageChatSwitch(
  fixture: ChromiumFixture,
  viewport: { height: number; width: number },
): Promise<void> {
  await fixture.page.setViewportSize(viewport);
  const sourceChatId = await seedTranscript(
    fixture.integration,
    90,
    `held-page-switch-source-${viewport.width}`,
  );
  const targetChatId = await seedTranscript(
    fixture.integration,
    8,
    `held-page-switch-target-${viewport.width}`,
  );
  const targetPage = await fixture.integration.client.getMessages(targetChatId, { limit: 200 });
  let releaseEarlierPage!: () => void;
  const earlierPageGate = new Promise<void>((resolve) => (releaseEarlierPage = resolve));
  let resolveEarlierRequest!: () => void;
  const earlierRequest = new Promise<void>((resolve) => (resolveEarlierRequest = resolve));
  let earlierRequestCount = 0;

  try {
    await prepareTranscript(fixture, sourceChatId);
    await fixture.page.evaluate((heldChatId) => {
      const browserGlobal = globalThis as typeof globalThis & {
        __restoreHeldEarlierPageFetch?: () => void;
      };
      const originalFetch = globalThis.fetch;
      browserGlobal.__restoreHeldEarlierPageFetch = () => {
        globalThis.fetch = originalFetch;
        delete browserGlobal.__restoreHeldEarlierPageFetch;
      };
      globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          typeof input === 'string' || input instanceof URL ? input : input.url,
          location.href,
        );
        if (
          url.pathname === '/api/v1/chats/messages' &&
          url.searchParams.get('chatId') === heldChatId &&
          url.searchParams.has('beforeOrdinal')
        ) {
          return originalFetch(input, { ...init, signal: undefined });
        }
        return originalFetch(input, init);
      }, originalFetch);
    }, sourceChatId);
    await fixture.page.route('**/api/v1/chats/messages?**', async (route) => {
      const url = new URL(route.request().url());
      if (
        url.searchParams.get('chatId') === sourceChatId &&
        url.searchParams.has('beforeOrdinal')
      ) {
        const response = await route.fetch();
        earlierRequestCount += 1;
        if (earlierRequestCount === 1) {
          resolveEarlierRequest();
          await earlierPageGate;
        }
        await route.fulfill({ response });
        return;
      }
      await route.continue();
    });
    await fixture.page.locator(FEED_SELECTOR).evaluate(async (feedElement) => {
      const feed = feedElement as HTMLElement;
      const target = Math.min(
        Math.max(0, feed.scrollHeight - feed.clientHeight),
        feed.clientHeight * 0.75,
      );
      feed.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -80 }));
      feed.scrollTop = target;
      feed.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    await withDiagnosticTimeout('the held source-chat earlier page', earlierRequest);
    await fixture.page.locator(`${FEED_SELECTOR}[aria-busy="true"]`).waitFor({ state: 'visible' });

    await selectSidebarChat(
      fixture.page,
      targetChatId,
      `held-page-switch-target-${viewport.width}-0`,
    );
    await waitForSurfaceIdentity(fixture.page, `${targetChatId}:${targetPage.transcriptViewId}`);
    const targetRevision = await virtualDataRevision(fixture.page);
    const targetEntryCount = await transcriptEntryCount(fixture.page);
    releaseEarlierPage();
    await fixture.page.evaluate(async () => {
      for (let frame = 0; frame < 12; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });

    expect(fixture.page.url()).toContain(`/chat/${targetChatId}`);
    expect(await transcriptEntryCount(fixture.page)).toBe(targetEntryCount);
    expect(await virtualDataRevision(fixture.page)).toBe(targetRevision);
    expect(await surfaceIdentity(fixture.page)).toBe(
      `${targetChatId}:${targetPage.transcriptViewId}`,
    );
    const targetScan = await scanLoadedTranscript(fixture.page);
    expect(targetScan.rows.map((row) => row.rowId)).toEqual(
      targetPage.messages.map((entry) => `${targetPage.transcriptViewId}:${entry.ordinal}`),
    );
    expect(targetScan.rows.map((row) => row.messageType)).toEqual(
      targetPage.messages.map((entry) => entry.message.type),
    );
    expect(targetScan.rows.map((row) => row.text)).toEqual(
      targetPage.messages.map((entry) => exactTranscriptText(entry.message)),
    );
    expect(
      await fixture.page
        .locator(FEED_SELECTOR)
        .getByText(`held-page-switch-source-${viewport.width}-0`, {
          exact: true,
        })
        .count(),
    ).toBe(0);
    expect(earlierRequestCount).toBe(1);
    fixture.assertNoBrowserErrors();
  } finally {
    releaseEarlierPage();
    await fixture.page
      .evaluate(() => {
        (
          globalThis as typeof globalThis & {
            __restoreHeldEarlierPageFetch?: () => void;
          }
        ).__restoreHeldEarlierPageFetch?.();
      })
      .catch(() => undefined);
    await fixture.page.unroute('**/api/v1/chats/messages?**');
  }
}

async function claudeNativeTranscript(
  fixture: ChromiumFixture,
  chatId: string,
): Promise<{ agentSessionId: string; path: string }> {
  const chat = await waitForPersistedNativeSession({
    directories: fixture.integration.dirs,
    chatId,
    agentId: 'claude',
  });
  const agentSessionId = typeof chat.agentSessionId === 'string' ? chat.agentSessionId : '';
  const nativeSession =
    chat.nativeSession && typeof chat.nativeSession === 'object'
      ? (chat.nativeSession as Record<string, unknown>)
      : null;
  const value =
    nativeSession?.value && typeof nativeSession.value === 'object'
      ? (nativeSession.value as Record<string, unknown>)
      : null;
  const path = typeof value?.path === 'string' ? value.path : '';
  if (!agentSessionId || !path) {
    throw new Error(`Claude chat ${chatId} has no persisted native transcript.`);
  }
  return { agentSessionId, path };
}

async function verifyDetachedNativeReload(
  fixture: ChromiumFixture,
  environment: ScriptedClaudeTestEnvironment,
  viewport: { height: number; width: number },
): Promise<void> {
  const chatId = await seedHeterogeneousTranscript(fixture, environment);
  const beforeReload = await fixture.integration.client.getMessages(chatId, {
    limit: 200,
  });
  await fixture.page.setViewportSize(viewport);
  await prepareTranscript(fixture, chatId, 1);
  await scrollToPosition(fixture.page, 'middle');
  expect(await viewportPolicy(fixture.page)).toEqual({
    pinned: false,
    userScrolledUp: true,
  });
  const oldSurfaceIdentity = await surfaceIdentity(fixture.page);
  expect(oldSurfaceIdentity).toBe(`${chatId}:${beforeReload.transcriptViewId}`);

  const native = await claudeNativeTranscript(fixture, chatId);
  const externalContent = `detached-native-reload-final-assistant-${viewport.width}`;
  await appendFile(
    native.path,
    `${JSON.stringify({
      sessionId: native.agentSessionId,
      type: 'assistant',
      uuid: crypto.randomUUID(),
      timestamp: new Date(Date.now() + 1_000).toISOString(),
      cwd: fixture.integration.dirs.project,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: externalContent }],
      },
    })}\n`,
    'utf8',
  );

  const reloaded = await fixture.integration.client.reloadChat(chatId);
  expect(reloaded.transcriptViewId).not.toBe(beforeReload.transcriptViewId);
  await waitForSurfaceIdentity(fixture.page, `${chatId}:${reloaded.transcriptViewId}`);
  await waitForTranscriptReady(fixture.page);
  expect(await surfaceIdentity(fixture.page)).not.toBe(oldSurfaceIdentity);

  const canonical = await fixture.integration.client.getMessages(chatId, {
    limit: 200,
  });
  expect(canonical.transcriptViewId).toBe(reloaded.transcriptViewId);
  expect(canonical.messages.at(-1)).toMatchObject({
    message: { type: 'assistant-message', content: externalContent },
  });
  await loadCompleteTranscript(fixture.page, canonical.messages.length);
  const renderedExpected = canonical.messages.filter(
    (entry) => entry.message.type !== 'tool-result',
  );
  const scan = await scanLoadedTranscript(fixture.page);
  expect(scan.rows.map((row) => row.rowId)).toEqual(
    renderedExpected.map((entry) => `${canonical.transcriptViewId}:${entry.ordinal}`),
  );
  expect(scan.rows.map((row) => row.messageType)).toEqual(
    renderedExpected.map((entry) => entry.message.type),
  );
  expect(scan.rows.at(-1)).toMatchObject({
    messageType: 'assistant-message',
    rowId: `${canonical.transcriptViewId}:${canonical.messages.at(-1)?.ordinal}`,
    text: externalContent,
  });
  expect(
    await fixture.page
      .locator(FEED_SELECTOR)
      .getByText(externalContent, { exact: true })
      .isVisible(),
  ).toBe(true);
  fixture.assertNoBrowserErrors();
}

async function verifyHeldEarlierPageNativeReload(
  fixture: ChromiumFixture,
  environment: ScriptedClaudeTestEnvironment,
): Promise<void> {
  const viewport = TRANSCRIPT_VIEWPORTS[0]!;
  const chatId = fixture.integration.newChatId();
  const baseUserContent = 'held-page-native-reload-base-user';
  const baseAssistantContent = 'held-page-native-reload-base-assistant';
  environment.model.scriptTurn([claudeText(baseAssistantContent)]);
  const started = await fixture.integration.client.startChat(
    liveClaudeStartRequest({
      chatId,
      projectPath: fixture.integration.dirs.project,
      command: baseUserContent,
      permissionMode: 'bypassPermissions',
    }),
  );
  expect((await fixture.integration.client.waitForTurnTerminal(chatId, started.turnId)).type).toBe(
    'agent-run-finished',
  );
  environment.model.assertSettled();
  const seeded = await fixture.integration.client.getMessages(chatId, {
    limit: 200,
  });
  const injected = mixedOrderingRows(seeded.lastOrdinal + 1);
  await appendLedgerRows(fixture, chatId, seeded.transcriptViewId, injected.drafts);
  const beforeReload = await fixture.integration.client.getMessages(chatId, {
    limit: 200,
  });
  expect(beforeReload.transcriptViewId).toBe(seeded.transcriptViewId);
  expect(beforeReload.hasMore).toBe(true);

  let releaseEarlierPage!: () => void;
  const earlierPageGate = new Promise<void>((resolve) => (releaseEarlierPage = resolve));
  let resolveEarlierRequest!: () => void;
  const earlierRequest = new Promise<void>((resolve) => (resolveEarlierRequest = resolve));
  let earlierRequestCount = 0;
  let heldRequestView = '';
  await fixture.page.route('**/api/v1/chats/messages?**', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('chatId') === chatId && url.searchParams.has('beforeOrdinal')) {
      const response = await route.fetch();
      earlierRequestCount += 1;
      if (earlierRequestCount === 1) {
        heldRequestView = url.searchParams.get('transcriptViewId') ?? '';
        resolveEarlierRequest();
        await earlierPageGate;
      }
      await route.fulfill({ response });
      return;
    }
    await route.continue();
  });

  try {
    await fixture.page.setViewportSize(viewport);
    await prepareTranscript(fixture, chatId, 1);
    await fixture.page.evaluate((heldChatId) => {
      const browserGlobal = globalThis as typeof globalThis & {
        __restoreHeldEarlierReloadFetch?: () => void;
      };
      const originalFetch = globalThis.fetch;
      browserGlobal.__restoreHeldEarlierReloadFetch = () => {
        globalThis.fetch = originalFetch;
        delete browserGlobal.__restoreHeldEarlierReloadFetch;
      };
      globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          typeof input === 'string' || input instanceof URL ? input : input.url,
          location.href,
        );
        if (
          url.pathname === '/api/v1/chats/messages' &&
          url.searchParams.get('chatId') === heldChatId &&
          url.searchParams.has('beforeOrdinal')
        ) {
          return originalFetch(input, { ...init, signal: undefined });
        }
        return originalFetch(input, init);
      }, originalFetch);
    }, chatId);
    await fixture.page.locator(FEED_SELECTOR).evaluate(async (feedElement) => {
      const feed = feedElement as HTMLElement;
      feed.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -80 }));
      feed.scrollTop = Math.min(
        Math.max(0, feed.scrollHeight - feed.clientHeight),
        feed.clientHeight * 0.75,
      );
      feed.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    await withDiagnosticTimeout('the held pre-reload earlier page', earlierRequest);
    await fixture.page.locator(`${FEED_SELECTOR}[aria-busy="true"]`).waitFor({ state: 'visible' });
    expect(heldRequestView).toBe(beforeReload.transcriptViewId);

    const native = await claudeNativeTranscript(fixture, chatId);
    const externalContent = 'held-page-native-reload-final-assistant';
    await appendFile(
      native.path,
      `${JSON.stringify({
        sessionId: native.agentSessionId,
        type: 'assistant',
        uuid: crypto.randomUUID(),
        timestamp: new Date(Date.now() + 1_000).toISOString(),
        cwd: fixture.integration.dirs.project,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: externalContent }],
        },
      })}\n`,
      'utf8',
    );

    const reloaded = await fixture.integration.client.reloadChat(chatId);
    expect(reloaded.transcriptViewId).not.toBe(beforeReload.transcriptViewId);
    await waitForSurfaceIdentity(fixture.page, `${chatId}:${reloaded.transcriptViewId}`);
    await waitForTranscriptReady(fixture.page);
    const replacementRevision = await virtualDataRevision(fixture.page);
    const replacementEntryCount = await transcriptEntryCount(fixture.page);

    releaseEarlierPage();
    await fixture.page.evaluate(async () => {
      for (let frame = 0; frame < 12; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });

    expect(earlierRequestCount).toBe(1);
    expect(await surfaceIdentity(fixture.page)).toBe(`${chatId}:${reloaded.transcriptViewId}`);
    expect(await virtualDataRevision(fixture.page)).toBe(replacementRevision);
    expect(await transcriptEntryCount(fixture.page)).toBe(replacementEntryCount);
    const canonical = await fixture.integration.client.getMessages(chatId, {
      limit: 200,
    });
    expect(canonical.transcriptViewId).toBe(reloaded.transcriptViewId);
    expect(canonical.messages.at(-1)).toMatchObject({
      message: { type: 'assistant-message', content: externalContent },
    });
    expect(canonical.messages.map(exactTranscriptRow)).toEqual([
      expect.objectContaining({ type: 'user-message', text: baseUserContent }),
      expect.objectContaining({
        type: 'assistant-message',
        text: baseAssistantContent,
      }),
      expect.objectContaining({
        type: 'assistant-message',
        text: externalContent,
      }),
    ]);
    expect(JSON.stringify(canonical.messages)).not.toContain(
      'mixed-final-assistant-after-all-tools',
    );
    await loadCompleteTranscript(fixture.page, canonical.messages.length);
    const renderedExpected = canonical.messages.filter(
      (entry) => entry.message.type !== 'tool-result',
    );
    const scan = await scanLoadedTranscript(fixture.page);
    expect(scan.rows.map((row) => row.rowId)).toEqual(
      renderedExpected.map((entry) => `${canonical.transcriptViewId}:${entry.ordinal}`),
    );
    expect(scan.rows.map((row) => row.messageType)).toEqual(
      renderedExpected.map((entry) => entry.message.type),
    );
    expect(scan.rows.map((row) => row.text)).toEqual(
      renderedExpected.map((entry) => exactTranscriptText(entry.message)),
    );
    expect(scan.rows.at(-1)).toMatchObject({
      messageType: 'assistant-message',
      rowId: `${canonical.transcriptViewId}:${canonical.messages.at(-1)?.ordinal}`,
      text: externalContent,
    });
    fixture.assertNoBrowserErrors();
  } finally {
    releaseEarlierPage();
    await fixture.page
      .evaluate(() => {
        (
          globalThis as typeof globalThis & {
            __restoreHeldEarlierReloadFetch?: () => void;
          }
        ).__restoreHeldEarlierReloadFetch?.();
      })
      .catch(() => undefined);
    await fixture.page.unroute('**/api/v1/chats/messages?**');
  }
}

async function verifyDirectChatExposesNativeReload(fixture: ChromiumFixture): Promise<void> {
  const chatId = await seedTranscript(
    fixture.integration,
    15,
    'chromium-direct-native-reload-base',
  );
  await prepareTranscript(fixture, chatId, 20);
  await scrollToPosition(fixture.page, 'end');
  await waitForStablePinnedTranscriptLayout(fixture.page, 'direct-native-reload-baseline');
  await openCurrentWorkspaceTabActionsMenu(fixture.page);
  expect(
    await fixture.page.getByRole('menuitem', { name: 'Reload from native history' }).count(),
  ).toBe(1);
  await fixture.page.keyboard.press('Escape');
  fixture.assertNoBrowserErrors();
}

async function verifyHiddenPortalCleanup(fixture: ChromiumFixture, chatId: string): Promise<void> {
  await prepareTranscript(fixture, chatId);
  await scrollToPosition(fixture.page, 'middle');
  const chatIdentity = await currentWorkspaceIdentity(fixture.page);
  await openCurrentWorkspaceAddMenu(fixture.page);
  await clickMenuItem(fixture.page, 'New Terminal');
  await fixture.page.locator(FEED_SELECTOR).waitFor({ state: 'hidden' });
  const terminalIdentity = await currentWorkspaceIdentity(fixture.page);
  await selectWorkspaceWindowSurface(fixture.page, chatIdentity.windowId, chatIdentity.surfaceId);
  await waitForTranscriptReady(fixture.page);
  await scrollToPosition(fixture.page, 'middle');

  const openVisibleMessageMenu = async (): Promise<void> => {
    await fixture.page.locator(FEED_SELECTOR).evaluate((feedElement) => {
      const feed = feedElement as HTMLElement;
      const viewport = feed.getBoundingClientRect();
      const row = [...feed.querySelectorAll<HTMLElement>('[data-chat-row-id]')].find(
        (candidate) => {
          const rect = candidate.getBoundingClientRect();
          return rect.height > 1 && rect.top >= viewport.top && rect.bottom <= viewport.bottom;
        },
      );
      const trigger = row?.querySelector<HTMLElement>('[data-slot="context-menu-trigger"]');
      if (!trigger) throw new Error('No visible message menu trigger was available.');
      const rect = trigger.getBoundingClientRect();
      trigger.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }),
      );
    });
  };
  await openVisibleMessageMenu();
  const menu = fixture.page.locator('[data-slot="context-menu-content"]');
  await menu.waitFor({ state: 'visible' });
  await menu.getByRole('menuitem', { name: 'Copy text' }).focus();

  await selectWorkspaceWindowSurface(
    fixture.page,
    terminalIdentity.windowId,
    terminalIdentity.surfaceId,
    true,
  );
  await fixture.page.locator(FEED_SELECTOR).waitFor({ state: 'hidden' });
  await menu.waitFor({ state: 'detached' });
  const hiddenState = await fixture.page.evaluate(() => {
    const layer = document.querySelector<HTMLElement>('[data-conversation-workspace-layer]');
    return {
      portalCount: document.querySelectorAll('[data-slot="context-menu-content"]').length,
      focusInsideHiddenConversation: Boolean(
        layer?.getAttribute('aria-hidden') === 'true' &&
        document.activeElement &&
        layer.contains(document.activeElement),
      ),
    };
  });
  expect(hiddenState).toEqual({
    portalCount: 0,
    focusInsideHiddenConversation: false,
  });

  await selectWorkspaceWindowSurface(fixture.page, chatIdentity.windowId, chatIdentity.surfaceId);
  await waitForTranscriptReady(fixture.page);
  await openVisibleMessageMenu();
  await menu.waitFor({ state: 'visible' });
  await fixture.page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
  fixture.assertNoBrowserErrors();
}

async function verifyTextScaleTransitions(fixture: ChromiumFixture, chatId: string): Promise<void> {
  await synchronizeNativeTranscriptGeneration(fixture, chatId);
  const { initialModelCount } = await prepareTranscript(fixture, chatId);
  await revealEarlierTranscript(fixture.page, initialModelCount);
  await scrollToPosition(fixture.page, 'middle');
  const chatIdentity = await currentWorkspaceIdentity(fixture.page);
  const detachedAnchor = await readingAnchor(fixture.page);
  const detachedLayout = await transcriptLayoutSnapshot(fixture.page, detachedAnchor.key);

  const terminalWindowId = await openNewWorkspaceWindow(fixture.page, 'New Terminal');
  await focusWorkspaceWindow(fixture.page, chatIdentity.windowId);
  await waitForTranscriptReady(fixture.page);
  await waitForTranscriptScale(fixture.page, 0.85);
  const twoWindowAnchor = await anchorByKey(fixture.page, detachedAnchor.key);
  const twoWindowLayout = await transcriptLayoutSnapshot(fixture.page, detachedAnchor.key);
  expect(
    Math.abs(twoWindowAnchor.offset - detachedAnchor.offset),
    JSON.stringify({ detachedAnchor, twoWindowAnchor, detachedLayout, twoWindowLayout }, null, 2),
  ).toBeLessThanOrEqual(1);

  const secondTerminalWindowId = await openNewWorkspaceWindow(fixture.page, 'New Terminal');
  const filesWindowId = await openNewWorkspaceWindow(fixture.page, 'Open Files');
  await focusWorkspaceWindow(fixture.page, chatIdentity.windowId);
  await waitForTranscriptReady(fixture.page);
  await waitForTranscriptScale(fixture.page, 0.7);
  await scrollToPosition(fixture.page, 'middle');
  const fourWindowAnchor = await readingAnchor(fixture.page);
  const fourWindowLayout = await transcriptLayoutSnapshot(fixture.page, fourWindowAnchor.key);
  const fourWindowGeometry = await transcriptGeometry(fixture.page);
  expect(fourWindowGeometry.overlaps).toEqual([]);
  expect(fourWindowGeometry.horizontalOverflow).toEqual([]);

  await closeWorkspaceWindow(fixture.page, filesWindowId);
  await closeWorkspaceWindow(fixture.page, secondTerminalWindowId);
  await closeWorkspaceWindow(fixture.page, terminalWindowId);
  await waitForTranscriptScale(fixture.page, 1);
  const restoredAnchor = await anchorByKey(fixture.page, fourWindowAnchor.key);
  const restoredLayout = await transcriptLayoutSnapshot(fixture.page, fourWindowAnchor.key);
  expect(
    Math.abs(restoredAnchor.offset - fourWindowAnchor.offset),
    JSON.stringify({ fourWindowAnchor, restoredAnchor, fourWindowLayout, restoredLayout }, null, 2),
  ).toBeLessThanOrEqual(1);
  const restoredGeometry = await transcriptGeometry(fixture.page);
  expect(restoredGeometry.overlaps).toEqual([]);
  expect(restoredGeometry.horizontalOverflow).toEqual([]);

  await scrollToPosition(fixture.page, 'end');
  const visibleScaleWindowId = await openNewWorkspaceWindow(fixture.page, 'New Terminal');
  await focusWorkspaceWindow(fixture.page, chatIdentity.windowId);
  await waitForTranscriptScale(fixture.page, 0.85);
  await waitForStablePinnedTranscriptLayout(fixture.page, 'visible-scale-enter');
  await closeWorkspaceWindow(fixture.page, visibleScaleWindowId);
  await waitForTranscriptScale(fixture.page, 1);
  await waitForStablePinnedTranscriptLayout(fixture.page, 'visible-scale-exit');

  const hiddenScaleWindowId = await openNewWorkspaceWindow(fixture.page, 'Open Files');
  await focusWorkspaceWindow(fixture.page, chatIdentity.windowId);
  await waitForTranscriptScale(fixture.page, 0.85);
  await waitForStablePinnedTranscriptLayout(fixture.page, 'hidden-scale-enter');
  await focusWorkspaceWindow(fixture.page, hiddenScaleWindowId);
  await fixture.page.locator(FEED_SELECTOR).waitFor({ state: 'hidden' });
  const hiddenAppendMarker = 'chromium-hidden-scaled-append';
  await appendTurn(fixture.integration, chatId, hiddenAppendMarker);
  await focusWorkspaceWindow(fixture.page, chatIdentity.windowId);
  await waitForTranscriptScale(fixture.page, 0.85);
  await fixture.page
    .locator(FEED_SELECTOR)
    .getByText(`echo:${hiddenAppendMarker}`, { exact: true })
    .waitFor();
  await waitForStablePinnedTranscriptLayout(fixture.page, 'hidden-scale-show');
  await closeWorkspaceWindow(fixture.page, hiddenScaleWindowId);
  await waitForTranscriptScale(fixture.page, 1);
  await waitForStablePinnedTranscriptLayout(fixture.page, 'hidden-scale-exit');
  fixture.assertNoBrowserErrors();
}

async function loadCompleteTranscript(page: Page, expectedEntryCount: number): Promise<void> {
  let entryCount = await transcriptEntryCount(page);
  const attempts: Array<{ before: number; after: number }> = [];
  const maximumPageCount = Math.ceil(expectedEntryCount / 50) + 2;
  for (
    let pageIndex = 0;
    pageIndex < maximumPageCount && entryCount < expectedEntryCount;
    pageIndex += 1
  ) {
    const previousEntryCount = entryCount;
    const previousRevision = await virtualDataRevision(page);
    await scrollToPosition(page, 'start');
    await waitForVirtualDataRevisionAfter(page, previousRevision);
    entryCount = await transcriptEntryCount(page);
    attempts.push({ before: previousEntryCount, after: entryCount });
    expect(entryCount, JSON.stringify({ expectedEntryCount, attempts })).toBeGreaterThan(
      previousEntryCount,
    );
  }
  expect(entryCount, JSON.stringify({ expectedEntryCount, attempts })).toBe(expectedEntryCount);
}

async function readCompleteCanonicalTranscript(
  fixture: ChromiumFixture,
  chatId: string,
): Promise<{ messages: TranscriptMessage[]; transcriptViewId: string }> {
  let response = await fixture.integration.client.getMessages(chatId, {
    limit: 200,
  });
  const transcriptViewId = response.transcriptViewId;
  let messages = [...response.messages];
  for (let pageCount = 1; response.hasMore; pageCount += 1) {
    if (pageCount > 10) throw new Error('Canonical transcript pagination did not converge.');
    const nextBeforeOrdinal = response.nextBeforeOrdinal;
    if (nextBeforeOrdinal === null) {
      throw new Error('A canonical transcript page is missing its raw continuation cursor.');
    }
    response = await fixture.integration.client.getMessages(chatId, {
      beforeOrdinal: nextBeforeOrdinal,
      limit: 200,
      transcriptViewId,
    });
    expect(response.transcriptViewId).toBe(transcriptViewId);
    messages = [...response.messages, ...messages];
  }
  return { messages, transcriptViewId };
}

async function dispatchClockedTranscriptPosition(
  page: Page,
  position: 'away' | 'end',
): Promise<void> {
  const geometry = await page.locator(FEED_SELECTOR).evaluate((feedElement, target) => {
    const feed = feedElement as HTMLElement;
    const maximum = Math.max(0, feed.scrollHeight - feed.clientHeight);
    const scrollTop = target === 'end' ? maximum : maximum / 2;
    feed.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        deltaY: scrollTop < feed.scrollTop ? -600 : 600,
      }),
    );
    feed.scrollTop = scrollTop;
    feed.dispatchEvent(new Event('scroll', { bubbles: true }));
    return { clientHeight: feed.clientHeight, maximum };
  }, position);
  expect(geometry.maximum).toBeGreaterThan(geometry.clientHeight * 2);
}

async function verifyLiveEdgeRetention(
  fixture: ChromiumFixture,
  viewport: { height: number; width: number },
): Promise<void> {
  const promptPrefix = `chromium-live-edge-retention-${viewport.width}`;
  const turnCount = 110;
  const expectedEntryCount = turnCount * 2;
  const chatId = await seedTranscript(fixture.integration, turnCount, promptPrefix);
  await fixture.page.setViewportSize(viewport);
  await prepareTranscript(fixture, chatId);
  await loadCompleteTranscript(fixture.page, expectedEntryCount);
  const canonicalBeforeIdle = await readCompleteCanonicalTranscript(fixture, chatId);
  expect(canonicalBeforeIdle.messages).toHaveLength(expectedEntryCount);

  const clockStart = Date.now();
  await fixture.page.clock.install({ time: clockStart });
  await fixture.page.clock.pauseAt(clockStart + 1_000);

  await dispatchClockedTranscriptPosition(fixture.page, 'end');
  await fixture.page.clock.runFor(100);
  expect(await transcriptEntryCount(fixture.page)).toBe(expectedEntryCount);

  await dispatchClockedTranscriptPosition(fixture.page, 'away');
  await fixture.page.clock.runFor(100);
  expect(await viewportPolicy(fixture.page)).toEqual({
    pinned: false,
    userScrolledUp: true,
  });

  await dispatchClockedTranscriptPosition(fixture.page, 'end');
  await fixture.page.clock.runFor(100);
  expect(await viewportPolicy(fixture.page)).toEqual({
    pinned: true,
    userScrolledUp: false,
  });
  await fixture.page.clock.runFor(RETIRED_LIVE_EDGE_PRUNE_INTERVAL_MS + 1);
  expect(await transcriptEntryCount(fixture.page)).toBe(expectedEntryCount);
  expect(await viewportPolicy(fixture.page)).toEqual({
    pinned: true,
    userScrolledUp: false,
  });

  const canonicalAfterIdle = await readCompleteCanonicalTranscript(fixture, chatId);
  expect(canonicalAfterIdle.transcriptViewId).toBe(canonicalBeforeIdle.transcriptViewId);
  expect(canonicalAfterIdle.messages.map(exactTranscriptRow)).toEqual(
    canonicalBeforeIdle.messages.map(exactTranscriptRow),
  );
  const finalEntry = canonicalAfterIdle.messages.at(-1);
  expect(finalEntry).toMatchObject({
    message: {
      content: `echo:${promptPrefix}-${turnCount - 1}`,
      type: 'assistant-message',
    },
  });
  const finalRow = fixture.page.locator(
    `[data-chat-row-id="${canonicalAfterIdle.transcriptViewId}:${finalEntry?.ordinal}"]`,
  );
  await finalRow.waitFor({ state: 'visible' });
  expect((await finalRow.innerText()).trim()).toBe(`echo:${promptPrefix}-${turnCount - 1}`);

  const laterPrompts = Array.from(
    { length: 3 },
    (_, index) => `${promptPrefix}-after-idle-${index}`,
  );
  for (const prompt of laterPrompts) {
    await appendTurn(fixture.integration, chatId, prompt);
  }
  await fixture.page.clock.runFor(100);
  expect(await viewportPolicy(fixture.page)).toEqual({
    pinned: true,
    userScrolledUp: false,
  });
  const expectedAfterGrowth = expectedEntryCount + laterPrompts.length * 2;
  expect(await transcriptEntryCount(fixture.page)).toBe(expectedAfterGrowth);

  await fixture.page.clock.runFor(RETIRED_LIVE_EDGE_PRUNE_INTERVAL_MS + 1);
  expect(await transcriptEntryCount(fixture.page)).toBe(expectedAfterGrowth);

  const canonicalAfterGrowth = await readCompleteCanonicalTranscript(fixture, chatId);
  expect(canonicalAfterGrowth.transcriptViewId).toBe(canonicalBeforeIdle.transcriptViewId);
  expect(
    canonicalAfterGrowth.messages
      .slice(0, canonicalBeforeIdle.messages.length)
      .map(exactTranscriptRow),
  ).toEqual(canonicalBeforeIdle.messages.map(exactTranscriptRow));
  expect(
    canonicalAfterGrowth.messages.slice(-laterPrompts.length * 2).map(exactTranscriptRow),
  ).toEqual(
    laterPrompts.flatMap((prompt) => [
      expect.objectContaining({ type: 'user-message', text: prompt }),
      expect.objectContaining({
        type: 'assistant-message',
        text: `echo:${prompt}`,
      }),
    ]),
  );
  const finalLiveEntry = canonicalAfterGrowth.messages.at(-1);
  expect(finalLiveEntry).toMatchObject({
    message: {
      type: 'assistant-message',
      content: `echo:${laterPrompts.at(-1)}`,
    },
  });
  await fixture.page
    .locator(
      `[data-chat-row-id="${canonicalAfterGrowth.transcriptViewId}:${finalLiveEntry?.ordinal}"]`,
    )
    .waitFor({ state: 'visible' });
  fixture.assertNoBrowserErrors();
}

async function verifyDetachedWindowRetention(fixture: ChromiumFixture): Promise<void> {
  const promptPrefix = 'chromium-retained-window';
  const turnCount = 110;
  const expectedEntryCount = turnCount * 2;
  const chatId = await seedTranscript(fixture.integration, turnCount, promptPrefix);
  await prepareTranscript(fixture, chatId);
  await loadCompleteTranscript(fixture.page, expectedEntryCount);

  const scan = await scanLoadedTranscript(fixture.page);
  expect(scan.duplicateMountedRowIds).toEqual([]);
  expect(scan.indexChanges).toEqual([]);
  expect(scan.visualOrderViolations).toEqual([]);
  expect(scan.rows).toHaveLength(expectedEntryCount);
  const ordinals = scan.rows.map((row) => Number(row.rowId.slice(row.rowId.lastIndexOf(':') + 1)));
  expect(ordinals.every(Number.isFinite)).toBe(true);
  expect(ordinals).toEqual([...ordinals].sort((left, right) => left - right));
  for (let turnIndex = 0; turnIndex < turnCount; turnIndex += 1) {
    const user = scan.rows[turnIndex * 2];
    const assistant = scan.rows[turnIndex * 2 + 1];
    const prompt = `${promptPrefix}-${turnIndex}`;
    expect(user).toMatchObject({ messageType: 'user-message', text: prompt });
    expect(assistant).toMatchObject({
      messageType: 'assistant-message',
      text: `echo:${prompt}`,
    });
    expect(user?.itemIndex).toBeLessThan(assistant?.itemIndex ?? -1);
    if (turnIndex + 1 < turnCount) {
      expect(assistant?.itemIndex).toBeLessThan(scan.rows[(turnIndex + 1) * 2]?.itemIndex ?? -1);
    }
  }

  await scrollToPosition(fixture.page, 'end');
  await fixture.page.evaluate(async () => {
    for (let frame = 0; frame < 8; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  });
  expect(await transcriptEntryCount(fixture.page)).toBe(expectedEntryCount);

  const livePrompt = `${promptPrefix}-live`;
  await appendTurn(fixture.integration, chatId, livePrompt);
  await fixture.page
    .locator(FEED_SELECTOR)
    .getByText(`echo:${livePrompt}`, { exact: true })
    .waitFor();
  expect(await transcriptEntryCount(fixture.page)).toBe(expectedEntryCount + 2);
  const tail = await fixture.page.locator(FEED_SELECTOR).evaluate(
    (feedElement, input) =>
      [...feedElement.querySelectorAll<HTMLElement>('[data-chat-row-id]')]
        .flatMap((row) => {
          const text = row.innerText.trim();
          if (text !== input.user && text !== input.assistant) return [];
          return [
            {
              itemIndex: Number(
                row.closest<HTMLElement>('[data-chat-virtual-item]')?.dataset.index,
              ),
              messageType: row.dataset.chatMessageType ?? '',
              rowId: row.dataset.chatRowId ?? '',
              text,
            },
          ];
        })
        .sort((left, right) => left.itemIndex - right.itemIndex),
    { user: livePrompt, assistant: `echo:${livePrompt}` },
  );
  expect(tail).toHaveLength(2);
  expect(tail[0]).toMatchObject({
    messageType: 'user-message',
    text: livePrompt,
  });
  expect(tail[1]).toMatchObject({
    messageType: 'assistant-message',
    text: `echo:${livePrompt}`,
  });
  expect(tail[0]?.itemIndex).toBeLessThan(tail[1]?.itemIndex ?? -1);

  const retainedGeometry = await transcriptGeometry(fixture.page);
  expect(retainedGeometry.itemCount).toBeGreaterThan(2);
  expect(retainedGeometry.transcriptItemCount).toBeGreaterThan(1);
  expect(retainedGeometry.overlaps).toEqual([]);
  expect(await mountedConversationDiscontinuities(fixture.page)).toEqual([]);
  fixture.assertNoBrowserErrors();
}

async function verifyMixedTranscriptOrdering(fixture: ChromiumFixture): Promise<void> {
  const chatId = await seedTranscript(fixture.integration, 1, 'mixed-ordering-ledger-baseline');
  const initial = await fixture.integration.client.getMessages(chatId, {
    limit: 200,
  });
  const generated = mixedOrderingRows(initial.lastOrdinal + 1);
  const expected = [...initial.messages.map(exactTranscriptRow), ...generated.expected];
  expect(expected).toHaveLength(268);
  await appendLedgerRows(fixture, chatId, initial.transcriptViewId, generated.drafts);

  const canonical = await readCompleteCanonicalTranscript(fixture, chatId);
  expect(canonical.transcriptViewId).toBe(initial.transcriptViewId);
  expect(canonical.messages.map(exactTranscriptRow)).toEqual(expected);
  expect(canonical.messages.at(-1)).toMatchObject({
    ordinal: expected.at(-1)?.ordinal,
    message: {
      type: 'assistant-message',
      content: 'mixed-final-assistant-after-all-tools',
    },
  });
  const renderedExpected = expected.filter((row) => row.type !== 'tool-result');

  for (const viewport of TRANSCRIPT_VIEWPORTS) {
    await fixture.page.setViewportSize(viewport);
    await prepareTranscript(fixture, chatId, 1);
    await loadCompleteTranscript(fixture.page, expected.length);
    const scan = await scanLoadedTranscript(fixture.page);
    const diagnostic = JSON.stringify({ viewport, scan }, null, 2);
    expect(scan.duplicateMountedRowIds, diagnostic).toEqual([]);
    expect(scan.indexChanges, diagnostic).toEqual([]);
    expect(scan.visualOrderViolations, diagnostic).toEqual([]);
    expect(scan.rows, diagnostic).toHaveLength(renderedExpected.length);
    expect(
      scan.rows.map((row) => row.rowId),
      diagnostic,
    ).toEqual(renderedExpected.map((row) => `${initial.transcriptViewId}:${row.ordinal}`));
    expect(
      scan.rows.map((row) => row.messageType),
      diagnostic,
    ).toEqual(renderedExpected.map((row) => row.type));

    for (const [index, expectedRow] of renderedExpected.entries()) {
      const rendered = scan.rows[index];
      expect(rendered, diagnostic).toBeDefined();
      if (!rendered) continue;
      if (
        expectedRow.type === 'user-message' ||
        expectedRow.type === 'assistant-message' ||
        expectedRow.type === 'bash-tool-use'
      ) {
        expect(rendered.text, diagnostic).toBe(expectedRow.text);
      } else if (expectedRow.type === 'compaction') {
        expect(rendered.text, diagnostic).toContain('Context compacted');
      }
    }

    const bashRows = scan.rows.filter((row) => row.messageType === 'bash-tool-use');
    expect(bashRows, diagnostic).toHaveLength(42);
    for (const row of bashRows) {
      expect(row.bashCommand, diagnostic).toEqual({
        buttonCount: 0,
        tagName: 'CODE',
        text: row.text,
      });
    }
    expect(
      scan.rows.filter(
        (row) =>
          row.messageType === 'assistant-message' &&
          row.text === 'repeated-equal-assistant-content',
      ),
      diagnostic,
    ).toHaveLength(6);
    expect(scan.rows.at(-1), diagnostic).toMatchObject({
      messageType: 'assistant-message',
      rowId: `${initial.transcriptViewId}:${expected.at(-1)?.ordinal}`,
      text: 'mixed-final-assistant-after-all-tools',
    });
    expect(
      await fixture.page
        .locator(FEED_SELECTOR)
        .getByText('mixed-final-assistant-after-all-tools', { exact: true })
        .isVisible(),
    ).toBe(true);
  }
  fixture.assertNoBrowserErrors();
}

async function verifyCrossPageToolPairPrepend(
  fixture: ChromiumFixture,
  viewport: { height: number; width: number },
): Promise<void> {
  const chatId = await seedTranscript(fixture.integration, 1, 'tool-boundary-baseline');
  const initial = await fixture.integration.client.getMessages(chatId, {
    limit: 200,
  });
  const generated = crossPageToolPairRows(initial.lastOrdinal + 1);
  await appendLedgerRows(fixture, chatId, initial.transcriptViewId, generated.drafts);

  await fixture.page.setViewportSize(viewport);
  const prepared = await prepareTranscript(fixture, chatId);
  expect(await transcriptEntryCount(fixture.page)).toBe(50);
  const toolUseRowId = `${initial.transcriptViewId}:${generated.toolUseOrdinal}`;
  const toolResultRowId = `${initial.transcriptViewId}:${generated.toolResultOrdinal}`;
  expect(await fixture.page.locator(`[data-chat-row-id="${toolUseRowId}"]`).count()).toBe(0);
  expect(await fixture.page.locator(`[data-chat-row-id="${toolResultRowId}"]`).count()).toBe(0);

  const { anchor, frames } = await revealEarlierTranscript(
    fixture.page,
    prepared.initialModelCount,
  );
  expect(frames.length).toBeGreaterThan(2);
  expect(
    frames.filter(
      (frame) =>
        !frame.connected ||
        !frame.sameNode ||
        frame.offset === null ||
        frame.rowId !== anchor.rowId ||
        frame.text !== anchor.text,
    ),
    JSON.stringify({ anchor, frames }, null, 2),
  ).toEqual([]);
  expect(
    Math.max(
      ...frames.map((frame) =>
        frame.offset === null ? Number.POSITIVE_INFINITY : Math.abs(frame.offset - anchor.offset),
      ),
    ),
    JSON.stringify({ anchor, frames }, null, 2),
  ).toBeLessThanOrEqual(1);

  const scan = await scanLoadedTranscript(fixture.page);
  const toolUse = scan.rows.filter((row) => row.rowId === toolUseRowId);
  const toolResult = scan.rows.filter((row) => row.rowId === toolResultRowId);
  expect(toolUse).toHaveLength(1);
  expect(toolResult).toHaveLength(1);
  expect(toolUse[0]).toMatchObject({ messageType: 'web-search-tool-use' });
  expect(toolResult[0]).toMatchObject({ messageType: 'tool-result' });
  expect(toolUse[0]?.itemIndex).toBeLessThan(toolResult[0]?.itemIndex ?? -1);
  expect(scan.duplicateMountedRowIds).toEqual([]);
  expect(scan.indexChanges).toEqual([]);
  expect(scan.visualOrderViolations).toEqual([]);
  fixture.assertNoBrowserErrors();
}

async function seedPermissionTranscript(
  fixture: ChromiumFixture,
  environment: ScriptedClaudeTestEnvironment,
): Promise<string> {
  const chatId = fixture.integration.newChatId();
  for (let index = 0; index < 8; index += 1) {
    environment.model.scriptTurn([claudeText(`permission history response ${index}`)]);
    const accepted =
      index === 0
        ? await fixture.integration.client.startChat(
            liveClaudeStartRequest({
              chatId,
              projectPath: fixture.integration.dirs.project,
              command: `permission history prompt ${index}`,
            }),
          )
        : await fixture.integration.client.runChat(
            liveClaudeRunRequest({
              chatId,
              command: `permission history prompt ${index}`,
            }),
          );
    expect(
      (await fixture.integration.client.waitForTurnTerminal(chatId, accepted.turnId)).type,
    ).toBe('agent-run-finished');
  }

  environment.model.scriptTurn([
    claudeToolUse('toolu_chromium_ask', 'AskUserQuestion', {
      questions: [
        {
          question: 'Which database?',
          header: 'Database',
          multiSelect: false,
          options: [
            { label: 'Postgres', description: 'Use the durable database.' },
            { label: 'SQLite', description: 'Use the embedded database.' },
          ],
        },
      ],
    }),
  ]);
  const cursor = fixture.integration.client.markEvents();
  await fixture.integration.client.runChat(
    liveClaudeRunRequest({
      chatId,
      command: 'ask the database question',
      permissionMode: 'bypassPermissions',
    }),
  );
  const permission = await fixture.integration.client.waitForTransientPermission(
    chatId,
    () => true,
    { afterIndex: cursor, timeoutMs: 30_000 },
  );
  expect(permission.message.type).toBe('permission-request');
  return chatId;
}

async function verifyPermissionDraftPersistence(
  fixture: ChromiumFixture,
  environment: ScriptedClaudeTestEnvironment,
): Promise<void> {
  const chatId = await seedPermissionTranscript(fixture, environment);
  await fixture.page.setViewportSize({ width: 900, height: 360 });
  const response = await fixture.page.goto(
    `${fixture.integration.garcon.baseUrl}/chat/${encodeURIComponent(chatId)}`,
    { waitUntil: 'domcontentloaded' },
  );
  if (!response?.ok()) throw new Error(`SPA navigation failed with ${response?.status()}.`);
	await waitForTranscriptReady(fixture.page);

	const postgres = fixture.page.getByRole('radio', { name: /Postgres/ });
	await postgres.waitFor({ state: 'visible' });
  await postgres.check();
  expect(await postgres.isChecked()).toBe(true);
  const permissionItem = fixture.page.locator(ITEM_SELECTOR).filter({ has: postgres });
  const permissionKey = await permissionItem.getAttribute('data-chat-virtual-item');
  if (!permissionKey) throw new Error('The permission row is missing its virtual identity.');

  await fixture.page.locator(FEED_SELECTOR).focus();
  await fixture.page.evaluate(() => new Promise<void>((resolve) => queueMicrotask(resolve)));
  await scrollToPosition(fixture.page, 'start');
  await fixture.page.waitForFunction(
    ({ itemSelector, key }) =>
      ![...document.querySelectorAll<HTMLElement>(itemSelector)].some(
        (item) => item.dataset.chatVirtualItem === key,
      ),
    { itemSelector: ITEM_SELECTOR, key: permissionKey },
  );

  await scrollToPosition(fixture.page, 'end');
  const restoredPostgres = fixture.page.getByRole('radio', {
    name: /Postgres/,
  });
  await restoredPostgres.waitFor({ state: 'visible' });
  expect(await restoredPostgres.isChecked()).toBe(true);
  environment.model.assertSettled();
  fixture.assertNoBrowserErrors();
}

async function verifyHistoricalPermissionIsInertAfterRestart(
  fixture: ChromiumFixture,
  environment: ScriptedClaudeTestEnvironment,
): Promise<void> {
  environment.model.scriptTurn([
    claudeToolUse('toolu_chromium_historical_ask', 'AskUserQuestion', {
      questions: [
        {
          question: 'Which durable store?',
          header: 'Database',
          multiSelect: false,
          options: [
            { label: 'Postgres', description: 'Use the durable database.' },
            { label: 'SQLite', description: 'Use the embedded database.' },
          ],
        },
      ],
    }),
  ]);
  const chatId = fixture.integration.newChatId();
  const cursor = fixture.integration.client.markEvents();
  await fixture.integration.client.startChat(
    liveClaudeStartRequest({
      chatId,
      projectPath: fixture.integration.dirs.project,
      command: 'ask a permission that survives restart',
      permissionMode: 'bypassPermissions',
    }),
  );
  const permission = await fixture.integration.client.waitForTransientPermission(
    chatId,
    () => true,
    { afterIndex: cursor, timeoutMs: 30_000 },
  );
  if (permission.message.type !== 'permission-request') {
    throw new Error('The scripted historical permission request was not published.');
  }
  const permissionOccurrenceId = permission.message.permissionOccurrenceId;

  await fixture.integration.restartGarcon();
  const response = await fixture.page.goto(
    `${fixture.integration.garcon.baseUrl}/chat/${encodeURIComponent(chatId)}`,
    { waitUntil: 'domcontentloaded' },
  );
  if (!response?.ok()) throw new Error(`SPA navigation failed with ${response?.status()}.`);
  await waitForTranscriptReady(fixture.page);

  const snapshot = await fixture.integration.client.getChatSnapshot(chatId, 50);
  expect(snapshot.transientFeed.rows).toEqual([]);
  expect(snapshot.transcript.availability).toBe('available');
  if (snapshot.transcript.availability !== 'available') {
    throw new Error('The restarted permission transcript is unavailable.');
  }
  expect(
    snapshot.transcript.messages.some(
      (entry) =>
        entry.message.type === 'permission-request' &&
        entry.message.permissionOccurrenceId === permissionOccurrenceId,
    ),
  ).toBe(true);

  const postgres = fixture.page.getByRole('radio', { name: /Postgres/ });
  await postgres.waitFor({ state: 'visible' });
  expect(await postgres.isDisabled()).toBe(true);
  expect(await fixture.page.getByRole('button', { name: /Submit answer/ }).count()).toBe(0);
  expect(await fixture.page.getByRole('button', { name: /^Skip$/ }).count()).toBe(0);
  environment.model.assertSettled();
  fixture.assertNoBrowserErrors();
}

interface ReusedPermissionFixturePaths {
  callbackLog: string;
  cancelRelease: string;
  requestLog: string;
}

interface ReusedPermissionScenario {
  finalReply: string;
  firstCommand: string;
  firstToolUseId: string;
  prompt: string;
  secondCommand: string;
  secondToolUseId: string;
}

type PermissionLifecycleMessage = Extract<
  ChatMessage,
  {
    type:
      'permission-request' | 'permission-cancelled' | 'permission-resolved' | 'permission-expired';
  }
>;

function isPermissionLifecycleMessage(message: ChatMessage): message is PermissionLifecycleMessage {
  return (
    message.type === 'permission-request' ||
    message.type === 'permission-cancelled' ||
    message.type === 'permission-resolved' ||
    message.type === 'permission-expired'
  );
}

async function readJsonLineLog(path: string): Promise<Record<string, unknown>[]> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return contents
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const value = JSON.parse(line) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Invalid reused-permission log line: ${line}`);
      }
      return value as Record<string, unknown>;
    });
}

async function waitForJsonLineLog(
  path: string,
  description: string,
  predicate: (records: readonly Record<string, unknown>[]) => boolean,
): Promise<Record<string, unknown>[]> {
  return await withDiagnosticTimeout(
    description,
    (async () => {
      for (;;) {
        const records = await readJsonLineLog(path);
        if (predicate(records)) return records;
        await Bun.sleep(20);
      }
    })(),
    30_000,
  );
}

function permissionRequestForCommand(
  messages: readonly TranscriptMessage[],
  command: string,
): TranscriptMessage {
  const request = messages.find(
    (entry) =>
      entry.message.type === 'permission-request' &&
      entry.message.requestedTool.type === 'bash-tool-use' &&
      entry.message.requestedTool.command === command,
  );
  if (!request) throw new Error(`Permission request was not committed for ${command}.`);
  return request;
}

async function waitForPermissionTranscript(
  fixture: ChromiumFixture,
  chatId: string,
  predicate: (messages: readonly TranscriptMessage[]) => boolean,
  description: string,
): Promise<Awaited<ReturnType<IntegrationFixture['client']['getMessages']>>> {
  return await withDiagnosticTimeout(
    description,
    (async () => {
      for (;;) {
        const page = await fixture.integration.client.getMessages(chatId, {
          limit: 100,
        });
        if (predicate(page.messages)) return page;
        await Bun.sleep(20);
      }
    })(),
    30_000,
  );
}

async function verifyReusedPermissionOccurrence(
  fixture: ChromiumFixture,
  environment: ScriptedClaudeTestEnvironment,
  paths: ReusedPermissionFixturePaths,
  scenario: ReusedPermissionScenario,
): Promise<void> {
  environment.model.scriptTurn([
    claudeToolUse(scenario.firstToolUseId, 'Bash', {
      command: scenario.firstCommand,
    }),
  ]);
  environment.model.scriptTurn([claudeText(scenario.finalReply)]);

  const chatId = fixture.integration.newChatId();
  const eventCursor = fixture.integration.client.markEvents();
  const turn = await fixture.integration.client.startChat(
    liveClaudeStartRequest({
      chatId,
      projectPath: fixture.integration.dirs.project,
      command: scenario.prompt,
    }),
  );
  const firstTransient = await fixture.integration.client.waitForTransientPermission(
    chatId,
    (row) => JSON.stringify(row.message).includes(scenario.firstCommand),
    { afterIndex: eventCursor, timeoutMs: 30_000 },
  );
  const secondTransient = await fixture.integration.client.waitForTransientPermission(
    chatId,
    (row) => JSON.stringify(row.message).includes(scenario.secondCommand),
    { afterIndex: eventCursor, timeoutMs: 30_000 },
  );
  if (
    firstTransient.message.type !== 'permission-request' ||
    secondTransient.message.type !== 'permission-request'
  ) {
    throw new Error('The reused Claude permission requests were not published.');
  }

  const requestLog = await waitForJsonLineLog(
    paths.requestLog,
    'the duplicated provider permission requests',
    (records) => records.filter((record) => record.command !== undefined).length === 2,
  );
  const providerRequests = requestLog.filter((record) => record.command !== undefined);
  expect(providerRequests).toHaveLength(2);
  expect(providerRequests[0]).toEqual({
    occurrence: 'first',
    requestId: expect.any(String),
    command: scenario.firstCommand,
    toolUseId: scenario.firstToolUseId,
  });
  expect(providerRequests[1]).toEqual({
    occurrence: 'second',
    requestId: providerRequests[0]?.requestId,
    command: scenario.secondCommand,
    toolUseId: scenario.secondToolUseId,
  });
  const reusedNativeRequestId = providerRequests[0]?.requestId;
  if (typeof reusedNativeRequestId !== 'string' || reusedNativeRequestId.length === 0) {
    throw new Error('The provider permission request ID was not recorded.');
  }

  const beforeTerminal = await fixture.integration.client.getChatSnapshot(chatId, 100);
  if (beforeTerminal.transcript.availability !== 'available') {
    throw new Error('The reused permission transcript is unavailable.');
  }
  const firstRequest = permissionRequestForCommand(
    beforeTerminal.transcript.messages,
    scenario.firstCommand,
  );
  const secondRequest = permissionRequestForCommand(
    beforeTerminal.transcript.messages,
    scenario.secondCommand,
  );
  if (
    firstRequest.message.type !== 'permission-request' ||
    secondRequest.message.type !== 'permission-request'
  ) {
    throw new Error('The committed reused permission rows changed type.');
  }
  const firstOccurrenceId = firstRequest.message.permissionOccurrenceId;
  const secondOccurrenceId = secondRequest.message.permissionOccurrenceId;
  expect(firstOccurrenceId).toMatch(PERMISSION_OCCURRENCE_UUID);
  expect(secondOccurrenceId).toMatch(PERMISSION_OCCURRENCE_UUID);
  expect(secondOccurrenceId).not.toBe(firstOccurrenceId);
  expect(firstTransient.permissionOccurrenceId).toBe(firstOccurrenceId);
  expect(secondTransient.permissionOccurrenceId).toBe(secondOccurrenceId);
  expect(beforeTerminal.transientFeed.rows.map((row) => row.permissionOccurrenceId).sort()).toEqual(
    [firstOccurrenceId, secondOccurrenceId].sort(),
  );

  const transcriptViewId = beforeTerminal.transcript.transcriptViewId;
  const firstRowId = `${transcriptViewId}:${firstRequest.ordinal}`;
  const secondRowId = `${transcriptViewId}:${secondRequest.ordinal}`;
  expect(firstRowId).not.toBe(secondRowId);
  expect(firstTransient.transcript.transcriptViewId).toBe(transcriptViewId);
  expect(secondTransient.transcript.transcriptViewId).toBe(transcriptViewId);

  const response = await fixture.page.goto(
    `${fixture.integration.garcon.baseUrl}/chat/${encodeURIComponent(chatId)}`,
    { waitUntil: 'domcontentloaded' },
  );
  if (!response?.ok()) throw new Error(`SPA navigation failed with ${response?.status()}.`);
  await waitForTranscriptReady(fixture.page);

  const firstRow = fixture.page.locator(`[data-chat-row-id="${firstRowId}"]`);
  const secondRow = fixture.page.locator(`[data-chat-row-id="${secondRowId}"]`);
  await firstRow.waitFor({ state: 'visible' });
  await secondRow.waitFor({ state: 'visible' });
  await firstRow.locator('summary').click();
  await secondRow.locator('summary').click();
  expect(JSON.parse(await firstRow.locator('pre').innerText())).toEqual({
    command: scenario.firstCommand,
  });
  expect(JSON.parse(await secondRow.locator('pre').innerText())).toEqual({
    command: scenario.secondCommand,
  });
  const firstAllow = firstRow.getByRole('button', { name: /Allow once/ });
  const secondAllow = secondRow.getByRole('button', { name: /Allow once/ });
  await firstAllow.waitFor({ state: 'visible' });
  await secondAllow.waitFor({ state: 'visible' });
  expect(await firstAllow.isEnabled()).toBe(true);
  expect(await secondAllow.isEnabled()).toBe(true);

  await writeFile(paths.cancelRelease, 'cancel first occurrence');
  await waitForJsonLineLog(paths.requestLog, 'the delayed provider cancellation', (records) =>
    records.some((record) => record.terminal === 'cancelled'),
  );
  const afterCancellation = await waitForPermissionTranscript(
    fixture,
    chatId,
    (messages) =>
      messages.some(
        (entry) =>
          entry.message.type === 'permission-cancelled' &&
          entry.message.permissionOccurrenceId === firstOccurrenceId,
      ),
    'the first permission occurrence cancellation',
  );
  const terminalRows = afterCancellation.messages.filter(
    (entry): entry is TranscriptMessage & { message: PermissionLifecycleMessage } =>
      entry.message.type === 'permission-cancelled' ||
      entry.message.type === 'permission-resolved' ||
      entry.message.type === 'permission-expired',
  );
  expect(
    terminalRows.map((entry) => ({
      type: entry.message.type,
      permissionOccurrenceId: entry.message.permissionOccurrenceId,
    })),
  ).toEqual([
    {
      type: 'permission-cancelled',
      permissionOccurrenceId: firstOccurrenceId,
    },
  ]);
  await firstAllow.waitFor({ state: 'hidden' });
  await secondAllow.waitFor({ state: 'visible' });
  expect(await secondAllow.isEnabled()).toBe(true);

  const firstControl = {
    serverInstanceId: beforeTerminal.transientFeed.serverInstanceId,
    chatId,
    runId: firstTransient.runId,
    permissionOccurrenceId: firstOccurrenceId,
  };
  fixture.assertNoBrowserErrors();
  const staleResponse = await fixture.page.evaluate(
    async (input) => {
      const stale = await fetch('/api/v1/chats/permissions/decision', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      return { status: stale.status, body: (await stale.json()) as unknown };
    },
    {
      clientRequestId: crypto.randomUUID(),
      chatId,
      permissionOccurrenceId: firstOccurrenceId,
      allow: true,
      alwaysAllow: false,
      control: firstControl,
    },
  );
  expect(staleResponse).toMatchObject({
    status: 409,
    body: { errorCode: 'VALIDATION_FAILED', retryable: false },
  });
  await fixture.page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  expect(fixture.browserErrors.splice(0)).toEqual([
    'console.error: Failed to load resource: the server responded with a status of 409 (Conflict)',
  ]);
  expect(await readJsonLineLog(paths.callbackLog)).toEqual([]);
  await secondAllow.waitFor({ state: 'visible' });
  expect(await secondAllow.isEnabled()).toBe(true);

  await secondAllow.click();
  const callbacks = await waitForJsonLineLog(
    paths.callbackLog,
    'the second permission provider callback',
    (records) => records.length === 1,
  );
  expect(callbacks).toEqual([
    {
      requestId: reusedNativeRequestId,
      subtype: 'success',
      response: {
        behavior: 'allow',
        updatedInput: { command: scenario.secondCommand },
      },
    },
  ]);

  const terminal = await fixture.integration.client.waitForTurnTerminal(chatId, turn.turnId, {
    afterIndex: eventCursor,
    timeoutMs: 30_000,
  });
  expect(terminal.type).toBe('agent-run-finished');
  const completed = await fixture.integration.client.getMessages(chatId, {
    limit: 100,
  });
  const permissionRows = completed.messages.filter(
    (entry): entry is TranscriptMessage & { message: PermissionLifecycleMessage } =>
      isPermissionLifecycleMessage(entry.message),
  );
  expect(
    permissionRows.map((entry) => ({
      ordinal: entry.ordinal,
      type: entry.message.type,
      permissionOccurrenceId: entry.message.permissionOccurrenceId,
    })),
  ).toEqual([
    {
      ordinal: firstRequest.ordinal,
      type: 'permission-request',
      permissionOccurrenceId: firstOccurrenceId,
    },
    {
      ordinal: secondRequest.ordinal,
      type: 'permission-request',
      permissionOccurrenceId: secondOccurrenceId,
    },
    {
      ordinal: expect.any(Number),
      type: 'permission-cancelled',
      permissionOccurrenceId: firstOccurrenceId,
    },
    {
      ordinal: expect.any(Number),
      type: 'permission-resolved',
      permissionOccurrenceId: secondOccurrenceId,
    },
  ]);
  expect(
    completed.messages.some(
      (entry) =>
        entry.message.type === 'assistant-message' && entry.message.content === scenario.finalReply,
    ),
  ).toBe(true);
  expect(await readJsonLineLog(paths.callbackLog)).toEqual(callbacks);
  await secondAllow.waitFor({ state: 'hidden' });
  environment.model.assertSettled();
  fixture.assertNoBrowserErrors();
}

describe('Chromium transcript virtualization', () => {
  let environment: ScriptedClaudeTestEnvironment | undefined;
  let browser: Browser | undefined;

  beforeAll(async () => {
    environment = await startScriptedClaudeTestEnvironment();
    try {
      browser = await launchChromiumBrowser();
    } catch (error) {
      environment.dispose();
      environment = undefined;
      throw error;
    }
  });

  afterAll(async () => {
    try {
      if (browser) await closeChromiumBrowser(browser);
    } finally {
      environment?.dispose();
    }
  });

  test('[TLV5-UX.01-CHROMIUM-01] preserves virtual transcript geometry across paging, appends, and scale', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    await withChromiumFixture(
      'transcript-virtualization-geometry',
      async (fixture, markPhase) => {
        markPhase('creating the geometry transcript');
        const chatId = await createTranscript(fixture);
        markPhase('verifying bounded prepend geometry');
        await verifyBoundedPrepend(fixture, chatId);
        markPhase('verifying later-page reading position');
        await verifyLaterPageReadingPosition(fixture, chatId);
        markPhase('verifying detached, hidden, and pinned append geometry');
        await verifyAppendGeometry(fixture, chatId);
        markPhase('verifying chat-switch end restoration');
        await verifyChatSwitchBottomRestore(fixture, chatId, testEnvironment);
        markPhase('verifying detached and pinned text-scale transitions');
        await verifyTextScaleTransitions(fixture, chatId);
      },
      diagnostics,
      { serverEnvironment: testEnvironment.serverEnvironment },
      browser,
    );
  }, 180_000);

  test('prefetches earlier history while the active turn is processing', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    await withChromiumFixture(
      'transcript-processing-prefetch',
      async (fixture, markPhase) => {
        markPhase('prefetching earlier history during a held processing turn');
        await verifyEarlierPrefetchDuringProcessing(fixture);
      },
      diagnostics,
      { serverEnvironment: environment.serverEnvironment },
      browser,
    );
  }, 180_000);

  for (const scenario of [
    {
      caseId: '[TLV5-UX.06-COMPACT-TOUCH-COMPLETED-01]',
      clampBeforeRelease: false,
      label: 'compact-completed',
      liveBehavior: 'completed',
      viewport: { height: 700, width: 390 },
    },
    {
      caseId: '[TLV5-UX.06-COMPACT-TOUCH-LIVE-01]',
      clampBeforeRelease: true,
      label: 'compact-live-expanding',
      liveBehavior: 'expanding',
      viewport: { height: 700, width: 390 },
    },
    {
      caseId: '[TLV5-UX.06-COMPACT-TOUCH-INTERRUPTED-01]',
      clampBeforeRelease: false,
      label: 'compact-paused-interrupted',
      liveBehavior: 'paused-interrupted',
      viewport: { height: 700, width: 390 },
    },
    {
      caseId: '[TLV5-UX.06-WIDE-TOUCH-COMPLETED-01]',
      clampBeforeRelease: false,
      label: 'wide-completed',
      liveBehavior: 'completed',
      viewport: { height: 900, width: 1280 },
    },
    {
      caseId: '[TLV5-UX.06-WIDE-TOUCH-LIVE-01]',
      clampBeforeRelease: true,
      label: 'wide-live-expanding',
      liveBehavior: 'expanding',
      viewport: { height: 900, width: 1280 },
    },
    {
      caseId: '[TLV5-UX.06-WIDE-TOUCH-INTERRUPTED-01]',
      clampBeforeRelease: false,
      label: 'wide-paused-interrupted',
      liveBehavior: 'paused-interrupted',
      viewport: { height: 900, width: 1280 },
    },
  ] satisfies TouchPrependScenario[]) {
    test(`${scenario.caseId} keeps touch scrolling stable through a ${scenario.label} earlier-page prepend`, async () => {
      if (!environment) throw new Error('Scripted Claude environment was not initialized.');
      await withChromiumFixture(
        `transcript-touch-prepend-${scenario.label}`,
        async (fixture, markPhase) => {
          markPhase(`continuing a touch drag through the ${scenario.label} prepend`);
          await verifyTouchDragPrepend(fixture, scenario);
        },
        diagnostics,
        { serverEnvironment: environment.serverEnvironment },
        browser,
      );
    }, 180_000);
  }

  test('stages an earlier-page prepend until post-touch momentum settles', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    await withChromiumFixture(
      'transcript-post-touch-momentum-prepend',
      async (fixture, markPhase) => {
        markPhase('continuing mobile momentum while an earlier page finishes loading');
        await verifyPostTouchMomentumPrepend(fixture);
      },
      diagnostics,
      { serverEnvironment: environment.serverEnvironment },
      browser,
    );
  }, 180_000);

  test('does not assign scrollTop for follow or prepend work while coasting', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    await withChromiumFixture(
      'transcript-coasting-scroll-write-gate',
      async (fixture, markPhase) => {
        markPhase('trapping transcript scroll writes during coasting corrections');
        await verifyNoOwnedScrollWritesDuringCoasting(fixture);
      },
      diagnostics,
      { serverEnvironment: environment.serverEnvironment },
      browser,
    );
  }, 180_000);

  for (const scenario of [
    {
      caseId: '[TLV5-UX.06-COMPACT-SCROLLBAR-01]',
      viewport: TRANSCRIPT_VIEWPORTS[0],
    },
    {
      caseId: '[TLV5-UX.06-WIDE-SCROLLBAR-01]',
      viewport: TRANSCRIPT_VIEWPORTS[1],
    },
  ] as const) {
    const { viewport } = scenario;
    test(`${scenario.caseId} keeps a ${viewport.label} scrollbar reversal stable through an earlier-page prepend`, async () => {
      if (!environment) throw new Error('Scripted Claude environment was not initialized.');
      await withChromiumFixture(
        `transcript-scrollbar-prepend-${viewport.label}`,
        async (fixture, markPhase) => {
          markPhase(`reversing a ${viewport.label} scrollbar drag during a held prepend`);
          await verifyScrollbarDragPrepend(fixture, viewport);
        },
        diagnostics,
        { serverEnvironment: environment.serverEnvironment },
        browser,
      );
    }, 180_000);
  }

  for (const scenario of [
    {
      caseId: '[TLV5-UX.06-COMPACT-KEYBOARD-01]',
      viewport: TRANSCRIPT_VIEWPORTS[0],
    },
    {
      caseId: '[TLV5-UX.06-WIDE-KEYBOARD-01]',
      viewport: TRANSCRIPT_VIEWPORTS[1],
    },
  ] as const) {
    const { viewport } = scenario;
    test(`${scenario.caseId} keeps a ${viewport.label} keyboard page stable through an earlier-page prepend`, async () => {
      if (!environment) throw new Error('Scripted Claude environment was not initialized.');
      await withChromiumFixture(
        `transcript-keyboard-prepend-${viewport.label}`,
        async (fixture, markPhase) => {
          markPhase(`paging a ${viewport.label} feed by keyboard during a held prepend`);
          await verifyKeyboardPrepend(fixture, viewport);
        },
        diagnostics,
        { serverEnvironment: environment.serverEnvironment },
        browser,
      );
    }, 180_000);
  }

  test('navigates unmounted transcript rows and respects user cancellation', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    await withChromiumFixture(
      'transcript-virtualization-navigation',
      async (fixture, markPhase) => {
        markPhase('creating the navigation transcript');
        const chatId = await createTranscript(fixture);
        markPhase('verifying stable and growing target navigation');
        await verifyGrowingNavigation(fixture, chatId);
        markPhase('verifying navigation during a concurrent append');
        await verifyConcurrentAppendNavigation(fixture, chatId);
        markPhase('verifying fresh start- and end-edge navigation');
        await verifyEdgeNavigation(fixture, chatId);
        markPhase('verifying user cancellation during target growth');
        await verifyTargetCancellation(fixture, chatId);
      },
      diagnostics,
      { serverEnvironment: testEnvironment.serverEnvironment },
      browser,
    );
  }, 180_000);

  test('retains transcript interactions and closes hidden transients', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    await withChromiumFixture(
      'transcript-virtualization-retention',
      async (fixture, markPhase) => {
        markPhase('creating the retention transcript');
        const chatId = await createTranscript(fixture);
        markPhase('verifying selection retention outside overscan');
        await verifySelectionRetention(fixture, chatId);
        markPhase('verifying portal cleanup before the Chat surface hides');
        await verifyHiddenPortalCleanup(fixture, chatId);
        markPhase('verifying permission draft persistence outside overscan');
        await verifyPermissionDraftPersistence(fixture, testEnvironment);
      },
      diagnostics,
      { serverEnvironment: testEnvironment.serverEnvironment },
      browser,
    );
  }, 180_000);

  test('[TLV5-PERM.08-BROWSER-CHROMIUM-01] keeps reused permission occurrences independently actionable', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const firstMarker = crypto.randomUUID().replaceAll('-', '');
    const secondMarker = crypto.randomUUID().replaceAll('-', '');
    const scenario: ReusedPermissionScenario = {
      finalReply: `reused permission complete ${crypto.randomUUID()}`,
      firstCommand: `rm -f ./reused-permission-first-${firstMarker}`,
      firstToolUseId: `toolu_reused_first_${firstMarker}`,
      prompt: `request two reused permissions ${crypto.randomUUID()}`,
      secondCommand: `rm -f ./reused-permission-second-${secondMarker}`,
      secondToolUseId: `toolu_reused_second_${secondMarker}`,
    };
    let wrapperPath = '';
    let paths: ReusedPermissionFixturePaths = {
      callbackLog: '',
      cancelRelease: '',
      requestLog: '',
    };
    await withChromiumFixture(
      'transcript-reused-permission-occurrences',
      async (fixture, markPhase) => {
        markPhase('routing reused provider permissions to distinct browser occurrences');
        await verifyReusedPermissionOccurrence(fixture, testEnvironment, paths, scenario);
      },
      diagnostics,
      {
        serverEnvironment: testEnvironment.serverEnvironment,
        resolveServerEnvironment(directories) {
          wrapperPath = join(directories.root, 'reused-permission-claude');
          paths = {
            callbackLog: join(directories.root, 'reused-permission-callbacks.jsonl'),
            cancelRelease: join(directories.root, 'reused-permission-cancel-release'),
            requestLog: join(directories.root, 'reused-permission-requests.jsonl'),
          };
          return {
            CLAUDE_BINARY: wrapperPath,
            GARCON_REUSED_PERMISSION_CALLBACK_LOG: paths.callbackLog,
            GARCON_REUSED_PERMISSION_CANCEL_RELEASE: paths.cancelRelease,
            GARCON_REUSED_PERMISSION_CLAUDE_BINARY: CLAUDE_BINARY,
            GARCON_REUSED_PERMISSION_REQUEST_LOG: paths.requestLog,
            GARCON_REUSED_PERMISSION_SECOND_COMMAND: scenario.secondCommand,
            GARCON_REUSED_PERMISSION_SECOND_TOOL_USE_ID: scenario.secondToolUseId,
          };
        },
        async prepareWorkspace() {
          await writeFile(
            wrapperPath,
            `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(REUSED_PERMISSION_CLAUDE_PROXY)} "$@"\n`,
          );
          await chmod(wrapperPath, 0o755);
        },
      },
      browser,
    );
  }, 180_000);

  test('[TLV5-PERM.07-CHROMIUM-RESTART-01] keeps historical permission rows inert after a server restart', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    await withChromiumFixture(
      'transcript-historical-permission-restart',
      async (fixture, markPhase) => {
        markPhase('restarting with a durable permission and no transient capability');
        await verifyHistoricalPermissionIsInertAfterRestart(fixture, testEnvironment);
      },
      diagnostics,
      { serverEnvironment: testEnvironment.serverEnvironment },
      browser,
    );
  }, 180_000);

  test('[TLV5-L10.03-CHROMIUM-01] exposes native-history reload for a direct chat', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    await withChromiumFixture(
      'transcript-native-history-reload',
      async (fixture, markPhase) => {
        markPhase('checking the direct-chat native reload capability');
        await verifyDirectChatExposesNativeReload(fixture);
      },
      diagnostics,
      { serverEnvironment: environment.serverEnvironment },
      browser,
    );
  }, 120_000);

  for (const scenario of [
    {
      caseId: '[TLV5-UX.11-COMPACT-SWITCH-01]',
      viewport: TRANSCRIPT_VIEWPORTS[0],
    },
    {
      caseId: '[TLV5-UX.11-WIDE-SWITCH-01]',
      viewport: TRANSCRIPT_VIEWPORTS[1],
    },
  ] as const) {
    const { viewport } = scenario;
    test(`${scenario.caseId} isolates a held earlier page across a ${viewport.label} chat switch`, async () => {
      if (!environment) throw new Error('Scripted Claude environment was not initialized.');
      await withChromiumFixture(
        `transcript-held-page-switch-${viewport.label}`,
        async (fixture, markPhase) => {
          markPhase(`switching a ${viewport.label} feed while its earlier page is held`);
          await verifyHeldEarlierPageChatSwitch(fixture, viewport);
        },
        diagnostics,
        { serverEnvironment: environment.serverEnvironment },
        browser,
      );
    }, 180_000);

    const reloadCaseId =
      viewport.label === 'compact'
        ? '[TLV5-UX.11-COMPACT-RELOAD-01]'
        : '[TLV5-UX.11-WIDE-RELOAD-01]';
    test(`${reloadCaseId} replaces an idle detached ${viewport.label} transcript from native history`, async () => {
      if (!environment) throw new Error('Scripted Claude environment was not initialized.');
      const testEnvironment = environment;
      await withChromiumFixture(
        `transcript-detached-native-reload-${viewport.label}`,
        async (fixture, markPhase) => {
          markPhase(`reloading a detached ${viewport.label} native transcript`);
          await verifyDetachedNativeReload(fixture, testEnvironment, viewport);
        },
        diagnostics,
        { serverEnvironment: testEnvironment.serverEnvironment },
        browser,
      );
    }, 180_000);
  }

  test('[TLV5-PAGE.05-CHROMIUM-01] ignores a held old-view page after native history replaces the transcript', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    await withChromiumFixture(
      'transcript-held-page-native-reload',
      async (fixture, markPhase) => {
        markPhase('releasing an old-view page after native transcript replacement');
        await verifyHeldEarlierPageNativeReload(fixture, testEnvironment);
      },
      diagnostics,
      { serverEnvironment: testEnvironment.serverEnvironment },
      browser,
    );
  }, 180_000);

  test('[TLV5-UX.09-CHROMIUM-01] renders mixed paged transcripts in exact ledger order on compact and wide layouts', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    await withChromiumFixture(
      'transcript-mixed-ordering',
      async (fixture, markPhase) => {
        markPhase('verifying exact mixed-row and final-assistant order');
        await verifyMixedTranscriptOrdering(fixture);
      },
      diagnostics,
      { serverEnvironment: environment.serverEnvironment },
      browser,
    );
  }, 180_000);

  for (const scenario of [
    {
      caseId: '[TLV5-UX.06-COMPACT-TOOL-PAIR-01]',
      viewport: TRANSCRIPT_VIEWPORTS[0],
    },
    {
      caseId: '[TLV5-UX.06-WIDE-TOOL-PAIR-01]',
      viewport: TRANSCRIPT_VIEWPORTS[1],
    },
  ] as const) {
    const { viewport } = scenario;
    test(`${scenario.caseId} keeps a ${viewport.label} reading row stable when paging completes a tool pair`, async () => {
      if (!environment) throw new Error('Scripted Claude environment was not initialized.');
      await withChromiumFixture(
        `transcript-cross-page-tool-pair-${viewport.label}`,
        async (fixture, markPhase) => {
          markPhase(`completing a ${viewport.label} tool pair across an earlier-page boundary`);
          await verifyCrossPageToolPairPrepend(fixture, viewport);
        },
        diagnostics,
        { serverEnvironment: environment.serverEnvironment },
        browser,
      );
    }, 180_000);
  }

  test('[TLV5-UX.04-CHROMIUM-01] retains the complete detached transcript through paging and live following', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    await withChromiumFixture(
      'transcript-detached-window-retention',
      async (fixture, markPhase) => {
        markPhase('paging and scanning the complete retained transcript');
        await verifyDetachedWindowRetention(fixture);
      },
      diagnostics,
      { serverEnvironment: environment.serverEnvironment },
      browser,
    );
  }, 180_000);

  for (const scenario of [
    {
      caseId: '[TLV5-UX.17-COMPACT-CHROMIUM-01]',
      viewport: TRANSCRIPT_VIEWPORTS[0],
    },
    {
      caseId: '[TLV5-UX.17-WIDE-CHROMIUM-01]',
      viewport: TRANSCRIPT_VIEWPORTS[1],
    },
  ] as const) {
    const { viewport } = scenario;
    test(`${scenario.caseId} retains a ${viewport.label} expanded transcript beyond the retired live-edge delay`, async () => {
      if (!environment) throw new Error('Scripted Claude environment was not initialized.');
      await withChromiumFixture(
        `transcript-live-edge-retention-${viewport.label}`,
        async (fixture, markPhase) => {
          markPhase(`verifying durable ${viewport.label} live-edge retention`);
          await verifyLiveEdgeRetention(fixture, viewport);
        },
        diagnostics,
        { serverEnvironment: environment.serverEnvironment },
        browser,
      );
    }, 180_000);
  }
});
