import type { Page } from 'puppeteer-core';

export async function installLightpandaWorkspaceGeometry(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    const nativeGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
      const nativeRect = nativeGetBoundingClientRect.call(this);
      if (!this.classList.contains('workspace-host-region')) return nativeRect;
      // Replaces Lightpanda's 10x10 placeholder for an otherwise uncomputed flex remainder.
      if (nativeRect.width !== 10 || nativeRect.height !== 10) return nativeRect;

      const mobile = matchMedia('(max-width: 768px)').matches;
      const chatList = document.querySelector<HTMLElement>('[data-workspace-chat-list]');
      const chatListWidth = mobile ? 0 : Number.parseFloat(chatList?.style.width ?? '') || 0;
      const left = chatList?.classList.contains('order-first') ? chatListWidth : 0;
      const width = Math.max(0, innerWidth - chatListWidth);
      const height = innerHeight;

      return {
        x: left,
        y: 0,
        top: 0,
        right: left + width,
        bottom: height,
        left,
        width,
        height,
        toJSON: () => ({ x: left, y: 0, width, height }),
      } as DOMRect;
    };
  });
}
