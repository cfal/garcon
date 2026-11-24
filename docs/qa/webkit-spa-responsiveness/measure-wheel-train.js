// Call armGarconWheelTrain(viewport) before wheeling; call finish() after the viewport settles.
globalThis.armGarconWheelTrain = (viewport) => {
  if (!(viewport instanceof HTMLElement)) throw new Error('Expected a scroll viewport');
  const stop = new AbortController();
  const frames = [];
  const wheels = [];
  const scrolls = [];
  const start = performance.now();
  const top = viewport.scrollTop;
  let frame;
  const tick = () => {
    frames.push(performance.now());
    frame = requestAnimationFrame(tick);
  };
  const options = { passive: true, capture: true, signal: stop.signal };
  viewport.addEventListener('wheel', (event) => {
    if (event.isTrusted) wheels.push({ at: performance.now(), dy: event.deltaY, mode: event.deltaMode });
  }, options);
  viewport.addEventListener('scroll', () => scrolls.push(performance.now()), options);
  frame = requestAnimationFrame(tick);
  function cancel() {
    stop.abort();
    cancelAnimationFrame(frame);
  }
  return {
    cancel,
    ready: () => frames.length >= 4,
    settled: () => {
      if (!wheels.length || !scrolls.length) return false;
      const last = Math.max(wheels.at(-1).at, scrolls.at(-1));
      return performance.now() - last >= 180 && frames.length >= 3 && frames.at(-3) > last;
    },
    finish() {
      if (!wheels.length || !scrolls.length) { cancel(); throw new Error('No trusted wheel or scroll'); }
      const first = wheels[0].at;
      const last = wheels.at(-1).at;
      const lastScroll = scrolls.at(-1);
      const settled = this.settled();
      cancel();
      const before = frames.findLastIndex(t => t <= first);
      const after = frames.findIndex(t => t > Math.max(last, lastScroll));
      if (before < 0 || after < 0 || !settled) throw new Error('Incomplete frame window');
      const round = t => Math.round(t * 10) / 10;
      const intervals = [];
      for (let i = before; i < after; i++) {
        intervals.push({ start: round(frames[i] - first), end: round(frames[i + 1] - first) });
      }
      return {
        wheelCount: wheels.length, pixelMode: wheels.every(w => w.mode === 0),
        wheelDelta: wheels.reduce((sum, w) => sum + w.dy, 0), moved: round(viewport.scrollTop - top),
        wheelSpan: round(last - first), scrollCount: scrolls.length,
        firstScroll: round(scrolls[0] - first), lastScroll: round(lastScroll - first),
        firstWheelAfterArm: round(first - start),
        idleGaps: frames.slice(1, before + 1).map((t, i) => round(t - frames[i])).slice(-8),
        intervals,
      };
    },
  };
};
