// Chromiagent code mode library, by SvRvS: continuous observation of a tab.
// Placed in front of every code mode script, so a script can watch a page non-stop and react to what
// happens in real time, as it happens. Events come from the page recorder (extension/recorder.js).

interface PageEvent {
  at: number;            // seconds since monitoring began
  type: 'dom' | 'fetch' | 'xhr' | 'ws' | 'console' | 'error' | 'nav' | 'title' | 'user' | 'scroll' | 'dialog' | 'media' | 'tab' | 'start' | 'dropped';
  [detail: string]: unknown;
}

interface ObserveOptions {
  seconds?: number;      // how long to keep watching (default 60; the script itself may run up to its timeoutSec)
  waitMs?: number;       // longest wait for one batch of events (default 5000)
  types?: PageEvent['type'][]; // only these event types reach the handler
}

interface ObserveResult {
  events: number;        // events seen
  batches: number;
  byType: Record<string, number>;
  stoppedBy: 'handler' | 'time';
  last?: PageEvent;
}

// Calls `handler` with every new batch of events until `seconds` pass or the handler returns true.
// The handler may act on the page in between (chrome.* / playwright.*); new events keep being recorded meanwhile.
async function observe(
  tabId: number,
  handler: (events: PageEvent[], elapsed: number) => unknown | Promise<unknown>,
  options: ObserveOptions = {},
): Promise<ObserveResult> {
  const { seconds = 60, waitMs = 5000, types } = options;
  const started = Date.now();
  const result: ObserveResult = { events: 0, batches: 0, byType: {}, stoppedBy: 'time' };
  await chrome.monitor({ tabId, action: 'start' });
  try {
    while (Date.now() - started < seconds * 1000) {
      const left = seconds * 1000 - (Date.now() - started);
      const batch = JSON.parse(await chrome.events({ tabId, waitMs: Math.min(waitMs, left) })) as { events: PageEvent[] };
      const events = types ? batch.events.filter((e) => types.includes(e.type)) : batch.events;
      if (!events.length) continue;
      result.events += events.length;
      result.batches++;
      for (const e of events) result.byType[e.type] = (result.byType[e.type] || 0) + 1;
      result.last = events[events.length - 1];
      if ((await handler(events, (Date.now() - started) / 1000)) === true) { result.stoppedBy = 'handler'; break; }
    }
  } finally {
    await chrome.monitor({ tabId, action: 'stop' }).catch(() => {});
  }
  return result;
}

// Waits until an event matches, e.g. untilEvent(id, (e) => e.type === 'fetch' && String(e.url).includes('/api/order')).
async function untilEvent(tabId: number, match: (e: PageEvent) => boolean, seconds = 60): Promise<PageEvent | null> {
  let found: PageEvent | null = null;
  await observe(tabId, (events) => { found = events.find(match) ?? null; return found !== null; }, { seconds });
  return found;
}
