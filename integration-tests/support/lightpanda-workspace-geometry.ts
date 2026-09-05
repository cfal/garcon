import type { Page } from 'puppeteer-core';

const MIN_USABLE_WORKSPACE_HOST_SIZE_PX = 100;

export async function installLightpandaWorkspaceGeometry(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    const nativeGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
      const nativeRect = nativeGetBoundingClientRect.call(this);
      if (!this.classList.contains('workspace-host-region')) return nativeRect;
      // Replaces Lightpanda's known square placeholders for an uncomputed flex remainder.
      const isPlaceholder =
        (nativeRect.width === 5 && nativeRect.height === 5) ||
        (nativeRect.width === 10 && nativeRect.height === 10) ||
        (nativeRect.width === 15 && nativeRect.height === 15);
      if (!isPlaceholder) return nativeRect;

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

export async function assertLightpandaWorkspaceGeometry(page: Page): Promise<void> {
  const workspaceGeometry = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[role="region"][aria-label="Workspace"]');
    if (!host) {
      if (document.querySelector('[data-auth-recovery]')) {
        return { kind: 'auth-recovery' } as const;
      }
      return { kind: 'missing' } as const;
    }

    const { width, height } = host.getBoundingClientRect();
    return { kind: 'workspace', width, height } as const;
  });

  if (workspaceGeometry.kind === 'auth-recovery') return;
  if (workspaceGeometry.kind === 'missing') {
    throw new Error('Lightpanda workspace geometry assertion could not find the workspace host.');
  }
  if (
    workspaceGeometry.width <= MIN_USABLE_WORKSPACE_HOST_SIZE_PX ||
    workspaceGeometry.height <= MIN_USABLE_WORKSPACE_HOST_SIZE_PX
  ) {
    throw new Error(
      `Lightpanda workspace geometry shim returned unusable host bounds: ${workspaceGeometry.width}x${workspaceGeometry.height}.`,
    );
  }
}
