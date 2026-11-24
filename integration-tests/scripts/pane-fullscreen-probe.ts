// Serialized into the page by both drivers. Row IDs and draft text never leave the page.
export async function installFullscreenProbe(panes: number) {
  const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  async function until(test: () => boolean, name: string) {
    const deadline = performance.now() + 20_000;
    while (!test()) {
      if (performance.now() >= deadline) throw new Error('Timed out: ' + name);
      await frame();
    }
  }
  const id = (n: number) => n === 0 ? 'window-main' : 'window-fs-' + n;
  const windowAt = (n: number) => document.querySelector<HTMLElement>(`[data-workspace-window-id="${id(n)}"]`);
  const panel = (n: number) => windowAt(n)?.querySelector<HTMLElement>('[data-conversation-panel]');
  const viewport = (n: number) => panel(n)?.querySelector<HTMLElement>('[data-chat-scroll-viewport]');
  const sizer = (n: number) => panel(n)?.querySelector<HTMLElement>('[data-chat-virtual-sizer]');
  const editor = () => document.querySelector<HTMLTextAreaElement>('[data-composer] textarea');
  const button = () => windowAt(0)?.querySelector<HTMLButtonElement>('[data-workspace-window-fullscreen]');
  const positions = Array.from({ length: panes }, (_, n) => n);
  const presented = (win: HTMLElement) => win.getClientRects().length !== 0 && getComputedStyle(win).visibility === 'visible';
  await until(() => document.querySelectorAll('[data-conversation-panel]').length === panes &&
    positions.every(n => viewport(n)?.getAttribute('aria-busy') === 'false' &&
      sizer(n) && getComputedStyle(sizer(n)!).visibility === 'visible' &&
      panel(n)?.querySelector('[data-chat-row-id]') && !panel(n)?.querySelector('[data-chat-layout-pending]')) &&
    editor()?.value === 'Synthetic draft 0', 'ready chat feeds and correct editor');
  const originalPanels = positions.map(n => panel(n)!);
  const originalFeeds = positions.map(n => viewport(n)!);
  const originalEditor = editor();
  await document.fonts.ready;
  const originalRects = positions.map(n => windowAt(n)!.getBoundingClientRect());
  function sameRect(a: DOMRect, b: DOMRect) {
    return Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 &&
      Math.abs(a.width - b.width) <= 1 && Math.abs(a.height - b.height) <= 1;
  }
  const focus = () => {
    const el = document.activeElement;
    if (el === editor()) return 'editor';
    if (el === button()) return 'toggle';
    if (el === document.body) return 'body';
    return el?.closest('[inert]') ? 'inert' : 'other';
  };
  function center(el: HTMLElement | null | undefined) {
    if (!el) throw new Error('Missing click target');
    const r = el.getBoundingClientRect();
    const x = Math.floor(r.x + r.width / 2), y = Math.floor(r.y + r.height / 2);
    if (!el.contains(document.elementFromPoint(x, y))) throw new Error('Click target is covered');
    return { x, y };
  }
  function snapshot(owner = 0) {
    const win = windowAt(owner)!;
    const hidden = positions.map(n => windowAt(n)!).filter(w => !presented(w));
    const target = windowAt(0)!;
    const command = '[data-conversation-panel-command-owner]';
    const anchor = '[data-conversation-panel-composer-anchor]';
    return {
      mounted: document.querySelectorAll('[data-chat-scroll-viewport]').length,
      sameFeeds: positions.filter(n => originalFeeds[n].isConnected && viewport(n) === originalFeeds[n] &&
        panel(n) === originalPanels[n]).length,
      presented: panes - hidden.length,
      fillsHost: sameRect(target.getBoundingClientRect(), target.closest('.workspace-host-region')!.getBoundingClientRect()),
      originalTiles: positions.every(n => sameRect(windowAt(n)!.getBoundingClientRect(), originalRects[n]!)),
      hiddenInert: hidden.filter(w => w.inert && w.getAttribute('aria-hidden') === 'true').length,
      hiddenOwners: hidden.filter(w => w.querySelector(command + ',' + anchor + ',[data-workspace-scroll-region="primary"]')).length,
      ownership: win.dataset.workspaceWindowCurrent === 'true' && !!win.querySelector(command) && !!win.querySelector(anchor) &&
        document.querySelectorAll(command).length === 1 && document.querySelectorAll(anchor).length === 1,
      draft: editor()?.value === 'Synthetic draft ' + owner && !editor()?.disabled,
      sameEditor: editor() === originalEditor, focus: focus(),
      browserFullscreen: !!document.fullscreenElement,
    };
  }
  let pending: Promise<{ stateMs: number; twoFramesMs: number }> | null = null;
  function arm(enter: boolean) {
    const target = button()!;
    const label = enter ? 'Exit fullscreen' : 'Fullscreen';
    if (pending || target.getAttribute('aria-label') === label) throw new Error('Unexpected initial toggle state');
    const point = center(target);
    pending = new Promise((resolve, reject) => {
      let started: number | undefined;
      const abort = new AbortController();
      const observer = new MutationObserver(check);
      const timer = setTimeout(() => {
        abort.abort(); observer.disconnect(); reject(new Error('No trusted toggle or expected state'));
      }, 10_000);
      function check() {
        if (started === undefined || target.getAttribute('aria-label') !== label) return;
        observer.disconnect();
        const start = started, observed = performance.now();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          clearTimeout(timer); abort.abort();
          resolve({ stateMs: observed - start, twoFramesMs: performance.now() - start });
        }));
      }
      observer.observe(target, { attributes: true, attributeFilter: ['aria-label'] });
      window.addEventListener('pointerdown', e => {
        if (!e.isTrusted || !e.composedPath().includes(target)) return;
        started = performance.now();
        check();
      }, { capture: true, signal: abort.signal });
    });
    return point;
  }
  async function finish() {
    if (!pending) throw new Error('No armed gesture');
    try { return await pending; } finally { pending = null; }
  }
  function readingMark() {
    const feed = viewport(1)!;
    const { top, bottom } = feed.getBoundingClientRect();
    for (const row of feed.querySelectorAll<HTMLElement>('[data-chat-virtual-item]')) {
      const rowId = row.querySelector<HTMLElement>('[data-chat-row-id]')?.dataset.chatRowId;
      const rect = row.getBoundingClientRect();
      if (rowId && rect.bottom > top + 1 && rect.top < bottom) return { rowId, offset: rect.top - top };
    }
    return null;
  }
  async function stableMark() {
    let last = readingMark(), stable = 0;
    await until(() => {
      const current = readingMark();
      stable = current && last && current.rowId === last.rowId && Math.abs(current.offset - last.offset) <= 0.5 ? stable + 1 : 0;
      last = current;
      return stable >= 5;
    }, 'stable reading anchor');
    return last!;
  }
  let before: Awaited<ReturnType<typeof stableMark>> | undefined;
  function moveReader(toEnd: boolean) {
    const feed = viewport(1)!;
    feed.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: toEnd ? 600 : -600 }));
    feed.scrollTop = toEnd ? feed.scrollHeight : (feed.scrollHeight - feed.clientHeight) / 2;
  }
  async function detachReader() {
    moveReader(false);
    await frame(); await frame();
    before = await stableMark();
    const feed = viewport(1)!;
    if (feed.scrollTop < 8 || feed.scrollHeight - feed.clientHeight - feed.scrollTop < 8) throw new Error('Reader not detached');
  }
  async function restoredReader() {
    if (!before) return null;
    const after = await stableMark();
    return { sameRow: before.rowId === after.rowId, deltaPx: Math.round((after.offset - before.offset) * 100) / 100 };
  }
  function prepareShortcut() {
    const el = editor()!;
    el.focus(); el.setSelectionRange(2, 6);
  }
  function selectedDraft() {
    const el = editor();
    return document.activeElement === el && el?.value === 'Synthetic draft 0' && el.selectionStart === 2 && el.selectionEnd === 6;
  }
  await frame(); await frame();
  Object.assign(window, { fullscreenQA: {
    arm, finish, snapshot, detachReader, restoredReader, prepareShortcut, selectedDraft,
    waitLabel: (enter: boolean) => until(() => button()?.getAttribute('aria-label') === (enter ? 'Exit fullscreen' : 'Fullscreen'), 'shortcut toggle'),
    waitProcessing: (busy: boolean) => until(() => windowAt(1)?.querySelector('[role="tab"]')?.hasAttribute('aria-describedby') === busy, 'hidden processing change'),
    endGap: () => { const v = viewport(0)!; return Math.round(v.scrollHeight - v.clientHeight - v.scrollTop); },
    modelCount: () => Number(sizer(1)?.dataset.chatVirtualModelCount),
    readerShows: (needle: string) => panel(1)?.textContent?.includes(needle) ?? false,
    async revealAppend(needle: string) {
      moveReader(true);
      await until(() => !!panel(1)?.textContent?.includes(needle), 'revealed appended response');
    },
    pointToTab: (n: number) => center(windowAt(n)?.querySelector<HTMLElement>('[role="tab"]')),
    waitOwner: (n: number) => until(() => {
      const s = snapshot(n);
      return s.ownership && s.draft;
    }, 'selected chat draft'),
  } });
  return { width: innerWidth, height: innerHeight };
}
