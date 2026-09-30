import type { Page } from 'puppeteer-core';

interface LightpandaVirtualScrollViewport extends HTMLElement {
  __garconLightpandaVirtualScroll?: {
    offset: number;
    sizer?: HTMLElement;
  };
}

// Supplies the scroll geometry Lightpanda does not lay out, so a virtual list can follow its own
// end. Without it the scroll extent is empty and every scrollTop write clamps to zero, which the
// list adopts as its position. The viewport reports a fixed height, an extent matching the
// sizer, and a clamped offset that shifts its reported rect as native scrolling shifts content.
export async function installLightpandaScrollGeometry(
  page: Page,
  viewportSelector: string,
  sizerSelector: string,
  viewportHeight: number,
): Promise<void> {
  await page.$eval(
    viewportSelector,
    (element, input) => {
      const viewport = element as HTMLElement;
      let offset = 0;
      const extent = () => {
        const sizer = viewport.querySelector<HTMLElement>(input.sizerSelector);
        return Math.max(input.viewportHeight, Number.parseFloat(sizer?.style.height ?? '') || 0);
      };
      Object.defineProperties(viewport, {
        clientHeight: { configurable: true, get: () => input.viewportHeight },
        scrollHeight: { configurable: true, get: extent },
        scrollTop: {
          configurable: true,
          get: () => offset,
          set: (value: number) => {
            offset = Math.min(Math.max(0, value), extent() - input.viewportHeight);
          },
        },
      });
      const nativeRect = viewport.getBoundingClientRect.bind(viewport);
      viewport.getBoundingClientRect = () => {
        const rect = nativeRect();
        const top = rect.top + offset;
        return {
          x: rect.x,
          y: top,
          top,
          left: rect.left,
          right: rect.right,
          bottom: top + input.viewportHeight,
          width: rect.width,
          height: input.viewportHeight,
          toJSON: () => ({}),
        };
      };
      viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
    },
    { sizerSelector, viewportHeight },
  );
}

export async function setLightpandaVirtualScrollTop(
  page: Page,
  viewportSelector: string,
  sizerSelector: string,
  scrollTop: number,
): Promise<void> {
  await page.$eval(
    viewportSelector,
    (element, input) => {
      const viewport = element as LightpandaVirtualScrollViewport;
      viewport.dispatchEvent(new Event('wheel'));
      const sizer = viewport.querySelector<HTMLElement>(input.sizerSelector);
      if (!sizer) throw new Error('Missing virtual sizer.');
      let scrollState = viewport.__garconLightpandaVirtualScroll;
      if (!scrollState) {
        const installedScrollState = { offset: viewport.scrollTop };
        scrollState = installedScrollState;
        Object.defineProperty(viewport, '__garconLightpandaVirtualScroll', {
          configurable: true,
          value: installedScrollState,
        });
        Object.defineProperty(viewport, 'scrollTop', {
          configurable: true,
          get: () => installedScrollState.offset,
          set: (value: number) => {
            installedScrollState.offset = value;
          },
        });
      }
      if (scrollState.sizer !== sizer) {
        const nativeSizerRect = sizer.getBoundingClientRect.bind(sizer);
        sizer.getBoundingClientRect = () => {
          const rect = nativeSizerRect();
          const top = rect.top - scrollState.offset;
          return {
            x: rect.x,
            y: top,
            top,
            left: rect.left,
            right: rect.right,
            bottom: top + rect.height,
            width: rect.width,
            height: rect.height,
            toJSON: () => ({}),
          };
        };
        scrollState.sizer = sizer;
      }
      viewport.scrollTop = input.scrollTop;
      viewport.dispatchEvent(new Event('scroll'));
    },
    { scrollTop, sizerSelector },
  );
}
