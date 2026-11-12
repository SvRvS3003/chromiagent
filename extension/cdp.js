// Chromiagent CDP relay, by SvRvS.
// Makes this Chrome look like a CDP browser endpoint so Playwright (connectOverCDP) can drive the
// user's real tabs. Browser-level commands are answered here; page commands go through chrome.debugger.
const cdp = (() => {
  let out = null;                 // send(message) to the Playwright client, null when none connected
  const tabSession = new Map();   // tabId -> sessionId we gave Playwright
  const childTab = new Map();     // child sessionId (iframes/workers) -> tabId
  const targetTab = new Map();    // real CDP targetId -> tabId
  const tabTarget = new Map();    // tabId -> real CDP targetId
  const inputQueue = new Map();   // tabId -> last queued input command

  const sessionOf = (tabId) => `tab-${tabId}`;
  const tabOf = (sessionId) => (sessionId.startsWith('tab-') ? Number(sessionId.slice(4)) : childTab.get(sessionId));
  const usable = (url) => /^https?:/i.test(url || '');   // never file://, chrome://, other extensions

  async function attach(tab, fresh = false) {
    // fresh: a tab Playwright just created; it has no URL yet.
    if (!out || tabSession.has(tab.id) || !(fresh || usable(tab.url))) return;
    try {
      await chrome.debugger.attach({ tabId: tab.id }, '1.3');
    } catch {
      return; // devtools open, discarded tab, or another debugger: skip it
    }
    // Real target info carries browserContextId, which Playwright requires to accept the page.
    const { targetInfo } = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Target.getTargetInfo');
    tabSession.set(tab.id, sessionOf(tab.id));
    targetTab.set(targetInfo.targetId, tab.id);
    tabTarget.set(tab.id, targetInfo.targetId);
    out({ method: 'Target.attachedToTarget', params: { sessionId: sessionOf(tab.id), targetInfo: { ...targetInfo, attached: true }, waitingForDebugger: false } });
  }

  function forget(tabId) {
    const sessionId = tabSession.get(tabId);
    if (!sessionId) return;
    const targetId = tabTarget.get(tabId);
    tabSession.delete(tabId);
    tabTarget.delete(tabId);
    targetTab.delete(targetId);
    for (const [s, t] of childTab) if (t === tabId) childTab.delete(s);
    inputQueue.delete(tabId);
    out && out({ method: 'Target.detachedFromTarget', params: { sessionId, targetId } });
  }

  async function browserCommand(method, params) {
    switch (method) {
      case 'Browser.getVersion':
        return { protocolVersion: '1.3', product: navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] || 'Chrome', revision: '', userAgent: navigator.userAgent, jsVersion: '' };
      case 'Target.setAutoAttach':
        for (const t of await chrome.tabs.query({})) await attach(t);
        return {};
      case 'Target.getTargets':
        return { targetInfos: await Promise.all([...tabSession.keys()].map(async (tabId) => (await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo')).targetInfo)) };
      case 'Target.getTargetInfo':
        return { targetInfo: { targetId: 'browser', type: 'browser', title: '', url: '', attached: true } };
      case 'Target.createTarget': {
        const url = params.url || 'about:blank';
        if (!usable(url) && url !== 'about:blank') throw new Error('Only http(s) pages are allowed');
        const t = await chrome.tabs.create({ url, active: false });
        await intoAgentGroup(t);
        // Attaching while the new tab is still committing gets dropped; wait for it to settle.
        for (let i = 0; i < 40 && (await chrome.tabs.get(t.id)).status !== 'complete'; i++) await new Promise((r) => setTimeout(r, 100));
        await attach(t, true);
        if (!tabTarget.has(t.id)) throw new Error('Could not attach to the new tab');
        return { targetId: tabTarget.get(t.id) };
      }
      case 'Target.closeTarget':
        await chrome.tabs.remove(targetTab.get(params.targetId));
        return { success: true };
      case 'Target.activateTarget':
        return {}; // the agent works in the background: it never pulls the user to its tab
      default:
        return {}; // permissions, download behavior, discovery: nothing to do for a real browser
    }
  }

  async function command({ id, method, params = {}, sessionId }) {
    // A reply is only sent to the client that asked: after a reconnect, late replies would confuse the new one.
    const asker = out;
    const reply = (m) => { if (out && out === asker) out(m); };
    try {
      let result;
      if (!sessionId) {
        result = await browserCommand(method, params);
      } else {
        const tabId = tabOf(sessionId);
        if (tabId === undefined) throw new Error(`No session ${sessionId}`);
        if (method === 'Page.navigate' && !usable(params.url)) throw new Error('file:// and browser-internal URLs are blocked');
        if (method === 'Page.bringToFront') { reply({ id, result: {}, sessionId }); return; } // stays in the background
        // Real actions light the tab up; Playwright's setup chatter on every tab does not.
        if (/^(Input\.|Page\.(navigate|reload)|Runtime\.(evaluate|callFunctionOn)$|DOM\.(focus|setFileInputFiles))/.test(method)) glow(tabId);
        const target = sessionId.startsWith('tab-') ? { tabId } : { tabId, sessionId };
        const send = () => chrome.debugger.sendCommand(target, method, params);
        if (method.startsWith('Input.')) {
          // Input runs in order per tab, so a release never overtakes a press that waits for the pointer.
          const run = (inputQueue.get(tabId) || Promise.resolve()).then(async () => {
            // Playwright's mouse drives the agent's own pointer: it glides there, then the real event fires.
            if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved') await pointTo(tabId, params.x, params.y, params.buttons ? 'drag' : 'Chromiagent');
            if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') { await pointTo(tabId, params.x, params.y, 'click'); pressAt(tabId); }
            if (method !== 'Input.dispatchMouseEvent') return send();
            // The page holds back the user's mouse while the agent works; this event is the agent's.
            await ui(tabId, 'pass', true).catch(() => {});
            try { return await send(); } finally { await ui(tabId, 'pass', false).catch(() => {}); }
          });
          inputQueue.set(tabId, run.catch(() => {}));
          result = await run;
        } else {
          result = await send();
        }
      }
      reply({ id, result: result || {}, sessionId });
    } catch (e) {
      reply({ id, error: { code: -32000, message: String(e.message || e) }, sessionId });
    }
  }

  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (!out || !tabSession.has(source.tabId)) return;
    if (method === 'Target.attachedToTarget') childTab.set(params.sessionId, source.tabId);
    out({ method, params, sessionId: source.sessionId || sessionOf(source.tabId) });
  });
  chrome.debugger.onDetach.addListener((source, reason) => { if (tabSession.has(source.tabId)) console.info("[chromiagent] debugger detached", source.tabId, reason); forget(source.tabId); });
  chrome.tabs.onRemoved.addListener(forget);
  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (!change.url) return;
    if (!usable(change.url)) { if (tabSession.has(tabId)) console.info("[chromiagent] tab left the web", tabId, change.url); chrome.debugger.detach({ tabId }).catch(() => {}); forget(tabId); return; }
    attach(tab); // new tab or a tab that just became a web page
  });

  async function close() {
    out = null;
    for (const tabId of [...tabSession.keys()]) await chrome.debugger.detach({ tabId }).catch(() => {});
    tabSession.clear();
    childTab.clear();
    targetTab.clear();
    tabTarget.clear();
  }
  let ready = Promise.resolve();

  return {
    attachedTabs: tabSession,
    // A new Playwright client starts clean, so it is told about every tab again.
    open(send) { console.info('[chromiagent] playwright connected'); ready = ready.then(close).then(() => { out = send; }); },
    message(msg) { ready.then(() => command(msg)); },
    close() { ready = ready.then(close); return ready; },
  };
})();
