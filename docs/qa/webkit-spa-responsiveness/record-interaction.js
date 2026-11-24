// Run in the page console, then call measureGarconInteraction('type', 'switch' or 'scroll').
globalThis.measureGarconInteraction?.cancel?.();
globalThis.measureGarconInteraction = (kind) => {
  if (!['type', 'switch', 'scroll'].includes(kind)) throw new Error('Unknown interaction');
  globalThis.measureGarconInteraction.cancel?.();
  const stop = new AbortController();
  const options = { capture: true, passive: true, signal: stop.signal };
  let start, middle, phase, target, samePane, composing;
  let frame, timer, samples = [], events = 0;
  const now = () => performance.now();
  const round = (value) => Math.round(value * 10) / 10;
  const finish = (data) => {
    if (stop.signal.aborted) return;
    stop.abort();
    clearTimeout(expiry);
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    delete globalThis.measureGarconInteraction.cancel;
    globalThis.garconInteractionSample = { kind, ...data };
  };
  const expiry = setTimeout(() => finish({ error: 'No completed interaction in 30 seconds' }), 30_000);
  const afterEvent = () => {
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const end = now();
        finish({ phase, toEventMs: round(middle - start), toTwoFramesMs: round(end - start),
          ...(kind === 'type' ? { composing } : {
            samePane, current: target.hasAttribute('data-workspace-window-current'),
          }) });
      });
    });
  };
  const inputTarget = (event) => event.target instanceof Element &&
    event.target.closest('[data-composer-plain-input], [data-composer-markdown-editor] [contenteditable=true]');
  if (kind === 'type') {
    addEventListener('beforeinput', (e) => {
      const editor = inputTarget(e);
      if (e.isTrusted && middle === undefined && editor) {
        start = now(); target = editor; phase = 'beforeinput to input';
      }
    }, options);
    addEventListener('input', (e) => {
      const editor = inputTarget(e);
      if (!e.isTrusted || !editor || middle !== undefined || (target && editor !== target)) return;
      middle = now(); start ??= middle; phase ??= 'input only'; composing = e.isComposing;
      afterEvent();
    }, options);
  } else if (kind === 'switch') {
    const pane = (e) => e.target instanceof Element &&
      e.target.closest('[data-chat-scroll-viewport]')?.closest('[data-workspace-window-id]');
    addEventListener('pointerdown', (e) => {
      if (!e.isTrusted || e.button !== 0 || !e.isPrimary || middle !== undefined) return;
      target = pane(e);
      if (target) { start = now(); samePane = target.hasAttribute('data-workspace-window-current'); }
    }, options);
    addEventListener('click', (e) => {
      if (!e.isTrusted || !target || pane(e) !== target || middle !== undefined) return;
      middle = now(); phase = 'pointerdown to click'; afterEvent();
    }, options);
  } else {
    const sampleFrame = () => { samples.push(now()); frame = requestAnimationFrame(sampleFrame); };
    addEventListener('scroll', (e) => {
      if (!e.isTrusted || !e.target.matches?.('[data-chat-scroll-viewport]') || (target && e.target !== target)) return;
      middle = now(); events++;
      if (!target) { target = e.target; start = middle; frame = requestAnimationFrame(sampleFrame); }
      clearTimeout(timer);
      timer = setTimeout(() => {
        const times = samples.filter(t => t <= middle);
        const gaps = times.slice(1).map((t, i) => round(t - times[i]));
        finish({ events, firstToLastScrollMs: round(middle - start),
          firstScrollToNextRafMs: samples.length ? round(samples[0] - start) : null,
          rafCallbacksDuringScroll: times.length, rafGapsMs: gaps });
      }, 250);
    }, options);
  }
  globalThis.garconInteractionSample = { kind, armed: true };
  globalThis.measureGarconInteraction.cancel = () => finish({ cancelled: true });
};
