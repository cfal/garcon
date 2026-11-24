// Separate from timing. Observes the native drawer handoff; never focuses or cancels an event.
export function drawerFocusProbe(ids: string[], drafts: string[]) {
  const q = (s: string) => document.querySelector<HTMLElement>(s);
  const firstTwo = ids.slice(0, 2);
  const chat = (id?: string) => id === firstTwo[0] ? 'A' : id === firstTwo[1] ? 'B' : '-';
  const draft = (text: string | undefined | null) => {
    for (const [i, d] of drafts.slice(0, 2).entries()) {
      if (d === text) return i ? 'B' : 'A';
      if (text && text.length === d.length + 1 && text.replace('x', '') === d) return i ? 'B+x' : 'A+x';
    }
    return text == null ? '-' : 'other';
  };
  const describe = (node: EventTarget | null) => {
    if (!(node instanceof Element)) return '-';
    if (node === document.body) return 'body';
    if (node.closest('[data-composer-plain-input]')) return 'source';
    if (node.closest('[data-composer-markdown-editor]')) return 'rich';
    const row = node.closest<HTMLElement>('[data-sidebar-virtual-row]');
    if (row) return 'row-' + chat(row.dataset.sidebarVirtualRow);
    if (node.closest('[data-workspace-chat-list]')) return 'drawer-' + node.tagName.toLowerCase();
    if (node.closest('nav button')?.textContent?.trim() === 'Menu') return 'menu';
    if (node.closest('[data-conversation-panel]')) return 'feed-' + node.tagName.toLowerCase();
    return node.tagName.toLowerCase();
  };
  const start = performance.now(), events: { ms: number; event: string; target: string; snapshot: string }[] = [];
  let previous = '', raf = 0;
  function record(event: string, target: EventTarget | null = null) {
    const p = q('[data-conversation-panel-composer-anchor]'), host = q('[data-conversation-composer-host]');
    const source = document.querySelector<HTMLTextAreaElement>('[data-composer-plain-input]');
    const rich = q('[data-composer-markdown-editor] [role=textbox]');
    const drawer = q('[data-workspace-chat-list][role=dialog]');
    const snapshot = [
      chat(location.pathname.split('/').at(-1)), chat(p?.dataset.conversationPanelChatId),
      host?.getAttribute('data-conversation-composer-host') && host.dataset.conversationComposerHost === p?.dataset.conversationPanel ? 'bound' : '-',
      host?.closest('[inert]') ? 'inert' : 'live', drawer?.dataset.state ?? '-', describe(document.activeElement),
      source?.parentElement?.hidden ? 'hidden' : 'shown', draft(source?.value), draft(rich?.textContent),
    ].join(' ');
    if (event !== 'state' || snapshot !== previous) events.push({ ms: Math.round(performance.now()-start), event, target: describe(target), snapshot });
    previous = snapshot;
  }
  const a = new AbortController();
  for (const type of ['pointerdown','click','focusin','focusout','keydown','beforeinput','input']) {
    window.addEventListener(type,e => { if(e.isTrusted) record(type, e.target) },{capture:true,passive:true,signal:a.signal});
  }
  const observer = new MutationObserver(() => record('state'));
  observer.observe(document.body, { subtree: true, childList: true, attributes: true,
    attributeFilter: ['inert','hidden','data-state','data-conversation-panel-composer-anchor','data-conversation-composer-host'] });
  function frame() { record('state'); raf = requestAnimationFrame(frame); }
  frame();
  return async () => {
    // Includes delayed close-focus and editor-focus callbacks, after the attempted key.
    await new Promise(resolve => setTimeout(resolve, 350));
    record('end');
    cancelAnimationFrame(raf); a.abort(); observer.disconnect();
    const click = events.find(e => e.event === 'click' && e.target.startsWith('row-'));
    return events.map(e => ({ ...e, ms: e.ms - (click?.ms ?? 0) }));
  };
}
