// Runs in the disposable browser. Content and actual row identities stay in this fixture's session storage.
export async function installTranscriptScrollProbe() {
  const shell = () => (window as Window & { __rowShell?: {
    capture(): unknown; arm(): unknown; info(): { hits: number; misses: number; eligible: number; captured: number };
  } }).__rowShell;
  const queryParams = new URLSearchParams(location.search);
  const bubbleSelector = '[data-chat-virtual-item] .user-message-context-target';
  const descendants = '[data-chat-virtual-item] .chat-message, [data-chat-virtual-item] .chat-message *';
  const paintRules: Record<string, [string, string]> = {
    unpainted: [descendants, 'visibility:hidden!important;'],
    flat: [descendants, 'box-shadow:none!important;text-shadow:none!important;border-radius:0!important;filter:none!important;backdrop-filter:none!important;background-image:none!important;transition:none!important;'],
    'bubble-shadow': [bubbleSelector, 'box-shadow:none!important;'],
    shadows: [descendants, 'box-shadow:none!important;'],
    corners: [descendants, 'border-radius:0!important;'],
    transitions: [descendants, 'transition:none!important;'],
  };
  const paint = queryParams.has('noRowPaint') ? 'unpainted'
    : queryParams.has('flatRowPaint') ? 'flat' : queryParams.get('rowPaint');
  if (paint) {
    const [selector, rules] = paintRules[paint]!;
    const style = document.createElement('style');
    style.textContent = selector + '{' + rules + '}';
    document.head.appendChild(style);
  }
  const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  async function frames(count = 3) { for (let i = 0; i < count; i++) await frame(); }
  const until = async (check: () => boolean, name: string) => {
    const end = performance.now() + 20_000;
    while (!check()) {
      if (performance.now() > end) throw Error('Timed out: ' + name);
      await frame();
    }
  };
  const query = '[data-workspace-window-id="window-main"] [data-chat-scroll-viewport]';
  await until(() => !!document.querySelector(query + ' [data-chat-virtual-item]'), 'real transcript rows');
  const view = document.querySelector<HTMLElement>(query)!;
  const sizer = view.querySelector<HTMLElement>('[data-chat-virtual-sizer]')!;
  const rows = () => [...sizer.querySelectorAll<HTMLElement>(':scope > [data-chat-virtual-item]')];
  await until(() => {
    if (Number(sizer.dataset.chatTranscriptEntryCount) === 98) return true;
    view.scrollTop = 0;
    return false;
  }, '98 loaded entries');
  await document.fonts.ready;
  await frames();

  const key = 'garcon-qa-synthetic-scroll-rows';
  type Sample = { signature: string; top: number };
  const reference: Record<string, Sample> = JSON.parse(sessionStorage.getItem(key) ?? '{}');
  const hasReference = Object.keys(reference).length > 0;
  const seen = new Set<string>();
  function checkRows() {
    const top = view.getBoundingClientRect().top, offset = view.scrollTop;
    for (const row of rows()) {
      const id = row.dataset.index!;
      const rect = row.getBoundingClientRect();
      const semantics = [...row.querySelectorAll('button,a,pre,code,em,strong,li,[role],.markdown-body .break-words')].map(el => [
        el.tagName, el.getAttribute('role'), el.getAttribute('aria-label'), el.getAttribute('aria-expanded'),
        el.getAttribute('href'), el.textContent, el.getBoundingClientRect().height,
      ]);
      const signature = JSON.stringify([row.dataset.chatVirtualItem, row.textContent, rect.width, rect.height, semantics]);
      if (hasReference && reference[id]?.signature !== signature) throw Error('Different row geometry, content or controls at index ' + id);
      if (!hasReference) reference[id] = { signature, top: offset + rect.top - top };
      seen.add(id);
    }
  }
  async function prepare() {
    // Initial chat activation can still be settling its end pin after rows first appear.
    // An earlier-reading intent detaches that pin before this untimed geometry walk.
    for (let i = 0; i < 12; i++) {
      view.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120 }));
      view.scrollTop = 0;
      await frames(4);
      if (view.scrollTop === 0 && view.scrollHeight > view.clientHeight) break;
    }
    if (view.scrollTop !== 0) throw Error('Could not detach and reach the first row');
    for (let i = 0; i < 160; i++) {
      checkRows();
      shell()?.capture();
      if (view.scrollTop + view.clientHeight >= view.scrollHeight - 1) break;
      view.scrollTop += Math.floor(view.clientHeight * 0.55);
      await frames();
    }
    const model = Number(sizer.dataset.chatVirtualModelCount);
    if (model !== 100 || seen.size !== model) throw Error('Incomplete row coverage: ' + seen.size + '/' + model);
    if (!hasReference) sessionStorage.setItem(key, JSON.stringify(reference));
    const control = shell();
    if (new URLSearchParams(location.search).get('rowShell') === 'clone') {
      if (!control) throw Error('Missing clone diagnostic');
      control.arm();
      const info = control.info();
      if (info.captured !== 98 || info.eligible !== info.captured) throw Error('Incomplete real-row clone table');
    }
    // A fresh fixture has new row keys; compare its ordered content, controls and geometry, not UUIDs.
    const portable = Array.from({ length: model }, (_, i) => JSON.parse(reference[i]!.signature).slice(1));
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(portable)));
    const contentDigest = Array.from(new Uint8Array(digest), v => v.toString(16).padStart(2, '0')).join('');
    return { rows: seen.size, width: view.clientWidth, height: view.clientHeight, inner: [innerWidth, innerHeight], contentDigest };
  }
  function snapshot() {
    const v = view.getBoundingClientRect(), mounted = rows();
    const first = mounted.find(row => {
      const r = row.getBoundingClientRect();
      return r.height > 0 && r.bottom > v.top + 0.5 && r.top < v.bottom;
    });
    if (!first) throw Error('No visible row');
    return {
      index: Number(first.dataset.index), offset: first.getBoundingClientRect().top - v.top,
      mounted: mounted.map(r => Number(r.dataset.index)), x: Math.floor(v.x + v.width / 2), y: Math.floor(v.y + v.height / 2),
      triggers: view.querySelectorAll('[data-slot="context-menu-trigger"]').length,
      inert: view.querySelectorAll('[data-row-menu-probe="inert"]').length,
      markdown: view.querySelectorAll('.markdown-body').length,
      simple: view.querySelectorAll('[data-row-text-probe="simple"]').length,
      topPlaced: mounted.filter(r => r.style.top !== '' && r.style.transform === '').length,
      cloned: view.querySelectorAll('[data-row-shell-cloned]').length, cloneMisses: shell()?.info().misses ?? 0,
      hiddenMessages: [...view.querySelectorAll('.chat-message')].filter(el => getComputedStyle(el).visibility === 'hidden').length,
      shadowed: [...view.querySelectorAll(bubbleSelector)].filter(el => getComputedStyle(el).boxShadow !== 'none').length,
      rounded: [...view.querySelectorAll(bubbleSelector)].filter(el => parseFloat(getComputedStyle(el).borderTopLeftRadius) > 0).length,
      buttonShadows: [...view.querySelectorAll('.chat-message-action-button')].filter(el => getComputedStyle(el).boxShadow !== 'none').length,
      buttonTransitions: [...view.querySelectorAll('.chat-message-action-button')].filter(el => getComputedStyle(el).transitionDuration.split(',').some(d => parseFloat(d) > 0)).length,
    };
  }
  async function anchor(index: number) {
    view.scrollTop = reference[index]!.top + 5;
    for (let i = 0; i < 20; i++) {
      await frames();
      const target = sizer.querySelector<HTMLElement>('[data-index="' + index + '"]');
      if (target) {
        const distance = target.getBoundingClientRect().top - view.getBoundingClientRect().top + 5;
        if (Math.abs(distance) <= 0.5) {
          const pre = snapshot();
          if (pre.index === index && Math.abs(pre.offset + 5) <= 0.5) return pre;
        }
        view.scrollTop += distance;
      } else {
        const prev = snapshot();
        view.scrollTop += prev.offset + (index - prev.index) * 80 + 5;
      }
    }
    throw Error('Reading anchor did not settle at index ' + index);
  }
  type Train = { ready(): boolean; settled(): boolean; finish(): unknown; cancel(): void };
  const arm = (globalThis as typeof globalThis & { armGarconWheelTrain: (v: HTMLElement) => Train }).armGarconWheelTrain;
  let train: Train | undefined;
  Object.assign(window, { rowEntryQA: {
    prepare, anchor,
    async begin() { checkRows(); train = arm(view); await until(() => train!.ready(), 'warm frame callbacks'); },
    async finish() {
      try {
        await until(() => train!.settled(), 'wheel settlement');
        const timing = train!.finish();
        checkRows();
        return { timing, post: snapshot() };
      } finally { train?.cancel(); }
    },
  } });
}
