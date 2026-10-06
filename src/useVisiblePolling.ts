import { useEffect, useRef, type DependencyList } from 'react';

// Serial polling: hidden tabs make no requests; returning to the tab catches up.
export function useVisiblePolling(task: () => Promise<unknown>, interval: number, dependencies: DependencyList) {
  const current = useRef(task);
  current.current = task;
  useEffect(() => {
    let disposed = false, running = false, failures = 0, retryAfter = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      if (disposed || document.hidden || running) return;
      running = true;
      try { await current.current(); failures = 0; retryAfter = 0; }
      catch (cause) { failures = Math.min(4, failures + 1); retryAfter = Math.max(0, Number((cause as { retryAfter?: number }).retryAfter || 0) * 1000); }
      finally {
        running = false;
        if (!disposed && !document.hidden) timer = setTimeout(poll, Math.max(retryAfter, Math.min(60000, interval * 2 ** failures)));
      }
    }
    function visibility() {
      clearTimeout(timer);
      if (!document.hidden) void poll();
    }
    document.addEventListener('visibilitychange', visibility);
    void poll();
    return () => { disposed = true; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); };
  }, dependencies);
}
