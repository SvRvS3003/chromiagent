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
