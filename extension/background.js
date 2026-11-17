// Chromiagent, by SvRvS. The toolbar button (and Alt+A) opens the agent panel.
if (chrome.sidePanel?.setPanelBehavior) {
  // Chrome, Edge, Brave, Vivaldi...: the panel docks on the side of the tab.
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
} else {
  // Chromium browsers without the side panel API: the same panel in a slim window.
  chrome.action.onClicked.addListener(() => {
    chrome.windows.create({ url: 'panel.html', type: 'popup', width: 460, height: 820 });
  });
}

// A control channel that lives in the service worker, not the panel: when the panel closes, the
// local host still has a way to ask us to open it again. The agent never has to ask the user.
let control = null;
async function reopenPanel() {
  try {
    if (chrome.sidePanel?.open) {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab?.id) { await chrome.sidePanel.open({ tabId: tab.id }); return; }
    }
  } catch {} // a user gesture is required in some versions — fall through to a plain panel tab
  try { await chrome.tabs.create({ url: chrome.runtime.getURL('panel.html'), active: false }); } catch {}
}
function connectControl() {
  try {
    const ws = new WebSocket('ws://127.0.0.1:17371/control');
    ws.onopen = () => { control = ws; };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } if (m.action === 'open_panel') reopenPanel(); };
    ws.onclose = () => { if (control === ws) control = null; setTimeout(connectControl, 1500); };
    ws.onerror = () => { try { ws.close(); } catch {} };
  } catch { setTimeout(connectControl, 2000); }
}
connectControl();
chrome.runtime.onStartup?.addListener(connectControl);
