import { describe, expect, test } from 'bun:test';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

function longTurn(marker: string): string {
  return `${marker} ${'navigation detail '.repeat(80)}`.trim();
}

describe('Lightpanda user-message navigation', () => {
  test('jumps from the active-chat menu to an earlier user turn', async () => {
    await withE2eFixture('user-message-navigator', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      const first = longTurn('navigator-first-turn');
      const second = longTurn('navigator-second-turn');
      const third = longTurn('navigator-third-turn');

      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat(first);
      await app.waitForText(`echo:${first}`);
      await app.sendComposer(second);
      await app.waitForText(`echo:${second}`);
      await app.sendComposer(third);
      await app.waitForText(`echo:${third}`);
      await app.waitForChatScrollTopGreaterThan(0);

      await app.clickButton('Workspace actions');
      await app.clickMenuItem('Jump to user message');
      await app.waitForText('User messages');

      const rows = await app.userMessageNavigatorRows();
      expect(rows).toHaveLength(3);
      expect(rows[0]?.startsWith('navigator-third-turn')).toBe(true);
      expect(rows[1]?.startsWith('navigator-second-turn')).toBe(true);
      expect(rows[2]?.startsWith('navigator-first-turn')).toBe(true);

      const before = await app.chatScrollTop();
      await app.trackChatScrollAssignments();
      await app.clickUserMessageNavigatorRowContaining('navigator-first-turn');
      await app.waitForTextAbsent('User messages');
      await app.waitForChatScrollAssignmentDifferentFrom(before);
      fixture.assertNoBrowserErrors();
    });
  });
});
