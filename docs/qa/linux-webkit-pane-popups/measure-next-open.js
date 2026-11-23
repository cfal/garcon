(() => {
  const listeners = new AbortController();
  function onInput(event) {
    let popup;
    let selector;
    if (event.type === 'pointerdown' && event.button === 0 && event.target instanceof Element) {
      const trigger = event.target.closest('[data-workspace-window-menu-trigger][aria-expanded="false"]');
      if (!trigger) return;
      popup = 'menu';
      selector = `[data-workspace-window-menu="${CSS.escape(trigger.dataset.workspaceWindowMenuTrigger)}"][data-state="open"]`;
    } else if (event.type === 'keydown' && event.ctrlKey && event.key === ',' && !event.repeat) {
      popup = 'settings';
      selector = '[data-slot="dialog-content"][data-state="open"]';
    } else {
      return;
    }
    const mark = `garcon:${popup}:input`;
    performance.mark(mark);
    listeners.abort();
    const observer = new MutationObserver(() => {
      if (!document.querySelector(selector)) return;
      observer.disconnect();
      clearTimeout(deadline);
      performance.measure(`garcon:${popup}:dom`, mark);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        performance.measure(`garcon:${popup}:two-frames`, mark);
      }));
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const deadline = setTimeout(() => observer.disconnect(), 5000);
  }
  const options = { capture: true, signal: listeners.signal };
  window.addEventListener('pointerdown', onInput, options);
  window.addEventListener('keydown', onInput, options);
})();
