import type { PaneBenchmarkDriver } from './pane-benchmark-driver.js';

export function composerInputClient(driver: PaneBenchmarkDriver) {
  type Probe = ReturnType<typeof composerInputProbe>;
  return <K extends keyof Probe>(method: K, ...args: Parameters<Probe[K]>) =>
    driver.evaluate<Awaited<ReturnType<Probe[K]>>>(`return window.inputQA.${method}(...arguments)`, ...args);
}

// Serialized into the isolated fixture page. Text, socket frames and chat IDs never leave it.
export function composerInputProbe(ids: string[], drafts: string[], compact: boolean, observeReplyDom = !compact) {
  const one = <T extends Element = HTMLElement>(selector: string, root: ParentNode = document) => root.querySelector<T>(selector);
  const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  async function until(test: () => boolean, label: string, timeout = 12_000) {
    const end = performance.now() + timeout;
    while (!test()) {
      if (performance.now() >= end) throw Error('Timed out: ' + label);
      await frame();
    }
  }
  const host = () => one('[data-conversation-composer-host]');
  const source = () => one<HTMLTextAreaElement>('[data-composer-plain-input]');
  const rich = () => one('[data-composer-markdown-editor] [role=textbox]');
  const panel = (i: number) => one(`[data-conversation-panel-chat-id="${ids[i]}"]:not([inert])`);
  const feed = (i: number) => panel(i)?.querySelector<HTMLElement>('[data-chat-scroll-viewport]');
  const anchor = (i: number) => !!panel(i)?.hasAttribute('data-conversation-panel-composer-anchor') &&
    panel(i)?.dataset.conversationPanel === host()?.dataset.conversationComposerHost && !host()?.closest('[inert]');
  const input = () => source()?.parentElement?.hidden ? rich() : source();
  function inputSurface(target: EventTarget | null) {
    if (target === rich()) return 'formatted';
    if (target === source()) return 'source';
    return 'other';
  }
  const textOf = (ed: HTMLElement | null | undefined) => ed instanceof HTMLTextAreaElement ? ed.value : ed?.textContent;
  const range = (ed: HTMLElement | null | undefined) => {
    if (ed instanceof HTMLTextAreaElement) return [ed.selectionStart, ed.selectionEnd];
    const s = window.getSelection();
    if (!ed || !s?.rangeCount || !ed.contains(s.anchorNode) || !ed.contains(s.focusNode)) return null;
    const offset = (node: Node, n: number) => {
      const r = document.createRange(); r.selectNodeContents(ed); r.setEnd(node, n); return r.toString().length;
    };
    return [offset(s.anchorNode!, s.anchorOffset), offset(s.focusNode!, s.focusOffset)];
  };
  const settledFeed = (i: number) => {
    const v = feed(i);
    return !!v && v.getClientRects().length > 0 && v.getAttribute('aria-busy') === 'false' &&
      !!one('[data-chat-row-id]', v) && !one('[data-chat-layout-pending="true"]', v) &&
      Math.abs(v.scrollHeight - v.clientHeight - v.scrollTop) <= 1;
  };
  const ownerReady = (i: number) => anchor(i) && location.pathname === '/chat/' + ids[i] &&
    rich()?.isContentEditable === true && source()?.parentElement?.hidden === true;
  const expected = (i: number, text: string) => ownerReady(i) && source()?.value === text && rich()?.textContent === text;
  async function state(i: number, text: string) {
    await until(() => ownerReady(i) && settledFeed(i), 'selected owner, rich editor and settled feed');
    await frame(); await frame();
    const ed = input();
    const value = source()?.value;
    return { correct: expected(i, text), pristine: value === drafts[i], editedAtEnd: value === drafts[i] + 'x',
      focus: document.activeElement === ed, caret: range(ed), pinned: settledFeed(i) };
  }
  const button = (i: number) => one<HTMLButtonElement>(`[data-sidebar-virtual-row="${ids[i]}"] .chat-item-root button`);
  function point(node: HTMLElement | null) {
    if (!node) throw Error('Missing native click target');
    const r = node.getBoundingClientRect(), x = Math.floor(r.x + r.width * .4), y = Math.floor(r.y + r.height / 2);
    return node.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
  }
  let original: HTMLElement | null = null;
  function position(i: number, offset: number) {
    const ed = rich();
    if (!ed || document.activeElement !== ed || !expected(i, drafts[i]!)) throw Error('Cannot stage the expected draft');
    const text = one('p', ed)?.firstChild;
    if (!text || text.nodeType !== Node.TEXT_NODE) throw Error('Expected a simple rich paragraph');
    const r = document.createRange(); r.setStart(text, offset); r.collapse(true);
    const s = getSelection()!; s.removeAllRanges(); s.addRange(r);
    if (original && ed !== original) throw Error('Foreground rich editor was replaced during key blocks');
    original = ed;
  }

  // Captures the real app socket on its next native inbound message, then immediately restores the getter.
  const prop = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data')!;
  if (!prop.configurable || !prop.get) throw Error('Cannot observe native socket delivery');
  let socket: WebSocket | null = null, disconnected = false;
  const abort = new AbortController(), opts = { capture: true, signal: abort.signal };
  let user = '', assistant = '', receipt: { kind: string; at: number; view: string; ordinal: number }[] = [];
  let projectedAt: number | null = null, observer: MutationObserver | null = null;
  function receive(e: MessageEvent) {
    if (!user || typeof e.data !== 'string' || !e.data.includes(ids[2]!)) return;
    const m = JSON.parse(e.data);
    if (m.type !== 'chat-messages' || m.chatId !== ids[2]) return;
    for (const { message, ordinal } of m.messages) {
      let kind = 'unexpected';
      if (message.type === 'user-message' && message.content === user) kind = 'user';
      else if (message.type === 'assistant-message' && message.content === assistant) kind = 'assistant';
      receipt.push({ kind, at: performance.now(), view: m.transcriptViewId, ordinal });
    }
  }
  Object.defineProperty(MessageEvent.prototype, 'data', { ...prop, get(this: MessageEvent) {
    const s = this.currentTarget;
    if (s instanceof WebSocket && new URL(s.url).host === location.host && new URL(s.url).pathname === '/ws') {
      socket = s; Object.defineProperty(MessageEvent.prototype, 'data', prop);
      s.addEventListener('message', receive, opts);
      s.addEventListener('close', () => { disconnected = true }, opts);
    }
    return prop.get!.call(this);
  } });

  let finish: (() => Promise<Record<string, unknown>>) | null = null;
  let down = 0, inputTime = 0, two = 0;
  function arm(i: number, offset: number, switching: boolean) {
    if (finish) throw Error('Previous sample not consumed');
    down = inputTime = two = 0;
    const before = drafts[i]!, after = before.slice(0, offset) + 'x' + before.slice(offset);
    let click = 0, beforeTime = 0, firstFrame = 0;
    let early = { owner: false, focused: false, text: false, caret: null as number[] | null, surface: 'none' };
    const destination = switching ? button(i) : null;
    let firstInput = false, trustedBefore = false, inputOwner = false, timers = 0;
    const control = new AbortController(), options = { capture: true, signal: control.signal };
    const time = () => performance.now();
    window.addEventListener('click', e => {
      if (destination && e.isTrusted && e.composedPath().includes(destination)) click = time();
    }, options);
    window.addEventListener('keydown', e => {
      if (!e.isTrusted || e.key !== 'x' || down) return;
      down = time(); const ed = input();
      early = { owner: anchor(i), focused: e.target === ed && document.activeElement === ed,
        text: textOf(ed) === before, caret: range(ed), surface: inputSurface(e.target) };
    }, options);
    window.addEventListener('beforeinput', e => {
      if (down && !beforeTime && e.isTrusted && e.inputType === 'insertText' && e.data === 'x') { beforeTime = time(); trustedBefore = true; }
    }, options);
    window.addEventListener('input', e => {
      if (!down || inputTime || !e.isTrusted || !(e instanceof InputEvent) || e.inputType !== 'insertText' || e.data !== 'x') return;
      inputTime = time(); const ed = input(); inputOwner = anchor(i) && e.target === ed;
      firstInput = textOf(ed) === after;
      requestAnimationFrame(() => { firstFrame = time(); requestAnimationFrame(() => { two = time() }); });
    }, options);
    finish = async () => {
      // A missed edit is a result. Wait only after the native key was offered.
      const deadline = time() + 1600;
      while (!two && time() < deadline) { await frame(); timers++; }
      control.abort(); finish = null;
      const s = await state(i, after).catch(() => ({ correct: false, focus: false, caret: range(input()), pinned: false }));
      const rightCaret = (v: number[] | null, n: number) => v?.[0] === n && v[1] === n;
      const ok = !!down && (!switching || (click > 0 && click <= down)) && early.owner && early.focused &&
        early.text && rightCaret(early.caret, offset) && trustedBefore && firstInput && inputOwner && !!two &&
        s.correct && s.focus && rightCaret(s.caret, offset + 1) && s.pinned && (switching || rich() === original);
      const diff = (t: number, from: number) => t && from ? Math.round(t - from) : null;
      return { ok, early, trustedBefore, inputOwner, firstInput, ...s, sameEditor: !switching && rich() === original,
        clickToKeyMs: diff(down, click), beforeMs: diff(beforeTime, down), inputMs: diff(inputTime, down),
        firstFrameMs: diff(firstFrame, down), twoMs: diff(two, down), missedFrames: two ? 0 : timers };
    };
  }
  return {
    async start(i: number) {
      await until(() => expected(i, drafts[i]!) && settledFeed(i) && (compact || ids.every((_, n) => settledFeed(n))), 'fixture readiness');
      await document.fonts.ready;
      return { width: innerWidth, height: innerHeight, visible: ids.filter((_, n) => settledFeed(n)).length };
    },
    async socketReady() { await until(() => !!socket && !disconnected, 'fixture app WebSocket'); },
    beginTurn(prompt: string, reply: string) {
      if (disconnected) throw Error('App socket disconnected');
      user = prompt; assistant = reply; receipt = []; projectedAt = null;
      if (observeReplyDom) {
        observer = new MutationObserver(records => {
          if (records.some(r => r.type === 'characterData' ? r.target.textContent?.includes(reply) :
            Array.from(r.addedNodes).some(node => node.textContent?.includes(reply)))) {
            projectedAt = performance.now(); observer?.disconnect();
          }
        });
        observer.observe(feed(2)!, { childList: true, subtree: true, characterData: true });
      }
    },
    async userSeen() { await until(() => receipt.some(e => e.kind === 'user') && (!observeReplyDom || !!feed(2)?.textContent?.includes(user)), 'user row on receiver'); },
    wireRows() { return receipt.map(({ ordinal, view }) => ({ ordinal, view })); },
    async delivery() {
      await until(() => receipt.some(e => e.kind === 'assistant') &&
        (!observeReplyDom || (projectedAt !== null && settledFeed(2) && !!feed(2)?.textContent?.includes(assistant))), 'assistant delivery and settled receiver');
      if (disconnected || receipt.map(e => e.kind).join(',') !== 'user,assistant') throw Error('Unexpected received row count or order');
      user = '';
      return { userMs: Math.round(receipt[0]!.at - down), assistantMs: Math.round(receipt[1]!.at - down),
        projectedMs: projectedAt === null ? null : Math.round(projectedAt - down),
        projectedDuringKey: projectedAt === null ? null : projectedAt >= down && projectedAt <= two,
        beforeKey: receipt.filter(e => e.at < down).length, duringKey: receipt.filter(e => e.at >= down && e.at <= two).length,
        afterKey: receipt.filter(e => e.at > two).length, visibleReceiver: !compact };
    },
    menu() {
      const trigger = Array.from(document.querySelectorAll<HTMLButtonElement>('nav button')).find(el => el.textContent?.trim() === 'Menu');
      return point(trigger ?? null);
    },
    editorPoint() { return point(rich()); },
    async row(i: number) {
      await until(() => !!button(i) && !!point(button(i)), 'visible destination button');
      return point(button(i))!;
    },
    async focusReady(i: number) { await until(() => ownerReady(i) && document.activeElement === rich(), 'explicit composer focus'); },
    position, arm, state,
    async result() { if (!finish) throw Error('No armed key'); return finish(); },
    async restored(i: number, offset: number) { await until(() => expected(i, drafts[i]!) && range(rich())?.join(',') === [offset, offset].join(',') &&
      rich() === original && document.activeElement === original && settledFeed(i), 'restored same editor and caret'); },
    async responseVisible(text: string) { await until(() => !!feed(2)?.textContent?.includes(text) && settledFeed(2), 'settled revealed response'); },
    close() { observer?.disconnect(); abort.abort(); if (!socket) Object.defineProperty(MessageEvent.prototype, 'data', prop); },
  };
}
