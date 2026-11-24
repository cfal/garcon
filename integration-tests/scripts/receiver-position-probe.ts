// Serialized into the synthetic page; only the optional attribution pass wraps the receiver.
export function receiverPositionProbe(chatId: string, pinned: boolean, counters: boolean) {
  const panel = document.querySelector(`[data-conversation-panel-chat-id="${chatId}"]:not([inert])`)!;
  const view = panel.querySelector<HTMLElement>('[data-chat-scroll-viewport]')!;
  const sizer = view.querySelector<HTMLElement>('[data-chat-virtual-sizer]')!;
  const rect = () => view.getBoundingClientRect();
  const row = (id: string) => sizer.querySelector<HTMLElement>('[data-chat-row-id="' + CSS.escape(id) + '"]');
  const visible = (node: HTMLElement) => {
    const r = node.getBoundingClientRect(), v = rect();
    return r.height > 0 && r.bottom > v.top && r.top < v.bottom;
  };
  const anchor = () => {
    const first = Array.from(sizer.querySelectorAll<HTMLElement>('[data-chat-row-id]')).find(visible);
    if (!first) throw Error('No visible receiver row');
    return { id: first.dataset.chatRowId!, offset: first.getBoundingClientRect().top - rect().top };
  };
  const counts = () => ({
    entries: Number(sizer.dataset.chatTranscriptEntryCount), model: Number(sizer.dataset.chatVirtualModelCount),
    revision: Number(sizer.dataset.chatVirtualDataRevision), first: Number(sizer.dataset.chatTranscriptFirstOrdinal),
  });
  const gap = () => view.scrollHeight - view.clientHeight - view.scrollTop;
  const ready = (atEnd: boolean) => view.isConnected && sizer.isConnected && !panel.closest('[inert]') &&
    view.getAttribute('aria-busy') === 'false' && !view.querySelector('[data-chat-layout-pending="true"]') &&
    view.dataset.chatPinnedToBottom === String(atEnd) && view.dataset.chatUserScrolledUp === String(!atEnd) &&
    (atEnd ? Math.abs(gap()) <= 1 : gap() >= 1100 && view.scrollTop >= 300);
  async function until(fn: () => boolean) {
    const deadline = performance.now() + 8000;
    while (!fn()) {
      if (performance.now() > deadline) throw Error('Receiver readiness failed: ' + JSON.stringify({ pinned, gap: gap(), ...counts() }));
      await new Promise<void>(r => requestAnimationFrame(() => r()));
    }
  }
  let startAnchor: ReturnType<typeof anchor>, base: ReturnType<typeof counts>, baselineTop = 0;
  let dimensions: number[] = [];
  let writes = 0, scrolls = 0, adds = 0, drops = 0;
  const undos: (() => void)[] = [];
  function instrument() {
    const scroll = () => { scrolls++; };
    view.addEventListener('scroll', scroll);
    undos.push(() => view.removeEventListener('scroll', scroll));
    const mo = new MutationObserver(records => {
      for (const rec of records) {
        for (const el of rec.addedNodes) if (el instanceof Element && el.matches('[data-chat-virtual-item]')) adds++;
        for (const el of rec.removedNodes) if (el instanceof Element && el.matches('[data-chat-virtual-item]')) drops++;
      }
    });
    mo.observe(sizer, { childList: true }); undos.push(() => mo.disconnect());
    const prop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!;
    Object.defineProperty(view, 'scrollTop', {
      configurable: true, get() { return prop.get!.call(view); }, set(v) { writes++; prop.set!.call(view, v); },
    });
    undos.push(() => { Reflect.deleteProperty(view, 'scrollTop'); });
    for (const name of ['scroll', 'scrollBy', 'scrollTo'] as const) {
      const fn = view[name];
      Object.defineProperty(view, name, { configurable: true, value(...args: unknown[]) { writes++; return Reflect.apply(fn, view, args); } });
      undos.push(() => { Reflect.deleteProperty(view, name); });
    }
    view.scrollTop = view.scrollTop; view.scrollBy(0, 0);
    if (writes !== 2) throw Error('Receiver write control failed');
  }
  function checkPosition() {
    if (view.clientWidth !== dimensions[0] || view.clientHeight !== dimensions[1]) throw Error('Receiver dimensions changed');
    const a = anchor();
    if (!pinned && (Math.abs(view.scrollTop - baselineTop) > 1 || a.id !== startAnchor.id || Math.abs(a.offset - startAnchor.offset) > 1)) {
      throw Error('Detached reading anchor moved');
    }
  }
  return {
    point() { const r = rect(); return { x: Math.floor(r.x + r.width / 2), y: Math.floor(r.y + r.height / 2) }; },
    async start() {
      await until(() => ready(pinned));
      startAnchor = anchor(); baselineTop = view.scrollTop; dimensions = [view.clientWidth, view.clientHeight];
      if (counters) instrument();
      return { dimensions, gap: gap(), ...counts() };
    },
    beginTurn() { checkPosition(); base = counts(); },
    async after(id: string, n: number) {
      await until(() => counts().entries === base.entries + n && counts().model === base.model + n && ready(pinned));
      checkPosition();
      const c = counts(), el = row(id);
      if (c.revision !== base.revision + n || c.first !== base.first || (pinned ? !el || !visible(el) : !!el)) throw Error('Wrong tail, model revision or window');
      if (n === 1) writes = scrolls = adds = drops = 0;
      return { entries: c.entries, revision: c.revision, mounted: !!el, gap: gap(), ...(counters ? { writes, scrolls, adds, drops } : {}) };
    },
    revealPoint() {
      const btn = panel.querySelector<HTMLButtonElement>('button[title="Scroll to bottom"]')!, r = btn.getBoundingClientRect();
      const x = Math.floor(r.x + r.width / 2), y = Math.floor(r.y + r.height / 2);
      if (!btn.contains(document.elementFromPoint(x, y))) throw Error('Cannot reveal receiver');
      return { x, y };
    },
    async revealed(id: string) { await until(() => ready(true) && !!row(id) && visible(row(id)!)); },
    close() { for (const undo of undos.reverse()) undo(); },
  };
}
