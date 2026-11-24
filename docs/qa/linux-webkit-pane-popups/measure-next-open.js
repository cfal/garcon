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
    // A listener installed from Inspector can run after the app has handled this input.
    const now = performance.now();
    const startTime = event.timeStamp > 0 && event.timeStamp <= now ? event.timeStamp : now;
    performance.mark(mark, { startTime });
    listeners.abort();
    function captureOpen() {
      if (!document.querySelector(selector)) return;
      observer.disconnect();
      clearTimeout(deadline);
      performance.measure(`garcon:${popup}:dom`, mark);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        performance.measure(`garcon:${popup}:two-frames`, mark);
      }));
    }
    const observer = new MutationObserver(captureOpen);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state'] });
    const deadline = setTimeout(() => observer.disconnect(), 5000);
    captureOpen();
  }
  const options = { capture: true, signal: listeners.signal };
  window.addEventListener('pointerdown', onInput, options);
  window.addEventListener('keydown', onInput, options);
})();
