import { expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { collapseCanonicalFilesWindow } from '../../support/chromium-workspace.js';
import { createTicketSource } from '../../support/ticket-source-fixture.js';

for (const width of [1440, 390]) {
  test(`ticket notices open the exact ticket repeatedly without losing the chat draft at ${width}px`, async () => {
    await withChromiumFixture(`ticket-notice-${width}`, async ({ page, integration, assertNoBrowserErrors }) => {
      const { chatId, ticketId } = await createTicketSource(integration);
      await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
      await collapseCanonicalFilesWindow(page);
      await page.setViewportSize({ width, height: 900 });
      const composer = page.locator('textarea:visible');
      await composer.fill('Synthetic retained notice draft.');
      const notice = page.locator('[data-ticket-command="create"]');
      await notice.waitFor();
      expect((await notice.innerText()).trim()).toBe(`Created ticket ${ticketId}`);
      expect(await page.getByText('Ticket command', { exact: true }).count()).toBe(0);
      const link = notice.getByRole('link', { name: ticketId, exact: true });
      expect(await link.getAttribute('href')).toBe(`/?ticket=${ticketId}`);
      const bounds = await notice.boundingBox();
      expect(bounds!.width).toBeGreaterThan(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      const artifacts = new URL('../../artifacts/chromium/', import.meta.url);
      await mkdir(artifacts, { recursive: true });
      await page.screenshot({ path: fileURLToPath(new URL(`ticket-notice-${width}.png`, artifacts)) });
      for (let click = 0; click < 2; click++) {
        await link.click();
        const detail = page.getByRole('region', { name: 'Ticket details', exact: true });
        await detail.waitFor();
        expect(await detail.getByRole('heading', { name: 'Synthetic source ticket', exact: true }).count()).toBe(1);
        expect(new URL(page.url()).pathname).toBe(`/chat/${chatId}`);
        if (width < 600) await page.getByRole('button', { name: 'Close Tickets', exact: true }).click();
        else await page.getByRole('tab', { name: 'Synthetic source navigation instruction.', exact: true }).click();
        await notice.waitFor();
        expect(await composer.inputValue()).toBe('Synthetic retained notice draft.');
      }
      assertNoBrowserErrors();
    });
  });
}
