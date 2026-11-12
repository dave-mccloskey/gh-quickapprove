/* exported createStallWatchdog */
/** Observes a pending state on its own deadline without changing application state. */
function createStallWatchdog(durationMs: number, report: (elapsedMs: number) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = 0;
  let deadline = 0;
  let generation = 0;

  function start() {
    stop();
    started = performance.now();
    deadline = started + durationMs;
    schedule();
  }

  function stop() {
    generation++;
    clearTimeout(timer);
    timer = undefined;
  }

  function schedule() {
    const current = generation;
    timer = setTimeout(
      () => {
        if (current !== generation) return;
        const now = performance.now();
        if (now >= deadline) {
          report(now - started);
          deadline = now + durationMs;
        }
        if (current === generation) schedule();
      },
      Math.max(1, deadline - performance.now()),
    );
  }

  return {
    start,
    stop,
    get active() {
      return timer !== undefined;
    },
  };
}
