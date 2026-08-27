import type { Page } from 'puppeteer-core';

interface LightpandaVirtualScrollViewport extends HTMLElement {
  __garconLightpandaVirtualScroll?: {
    offset: number;
    sizer?: HTMLElement;
  };
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
