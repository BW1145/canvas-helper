"use strict";

// Frame registration uses only Panopto content scripts. No history/cookie API.
const framesByTab = new Map();
const isPanopto = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /(^|\.)panopto\.(com|eu)$/i.test(url.hostname);
  } catch { return false; }
};

chrome.action.onClicked.addListener(async (tab) => {
  if (!Number.isInteger(tab.id)) return;
  let page = "dashboard.html";
  // activeTab authorizes this one source page, including Canvas custom domains.
  // Detect the real Canvas dashboard rather than matching an arbitrary homepage.
  try {
    const results = await chrome.scripting.executeScript({
      target: {tabId: tab.id, frameIds: [0]},
      func: () => location.protocol === "https:" && /^\/(?:dashboard\/?|)$/.test(location.pathname) &&
        Boolean(document.querySelector("#global_nav_dashboard_link, #dashboard_header_container, #DashboardCard_Container, .ic-DashboardCard"))
    });
    if (results[0]?.result === true) page = "courses.html";
  } catch { /* The existing downloader also handles a source that has navigated. */ }
  await chrome.tabs.create({url: chrome.runtime.getURL(`${page}?sourceTab=${tab.id}`)});
});

chrome.tabs.onRemoved.addListener((tabId) => framesByTab.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") framesByTab.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type === "PBT_FRAME_READY" && sender.tab && isPanopto(sender.url)) {
    const map = framesByTab.get(sender.tab.id) || new Map();
    const url = new URL(sender.url);
    // Keep only origin/path; query parameters may contain login tokens.
    map.set(sender.frameId, {
      tabId: sender.tab.id,
      frameId: sender.frameId,
      origin: url.origin,
      path: url.pathname,
      seenAt: Date.now()
    });
    framesByTab.set(sender.tab.id, map);
    respond({ok: true});
    return;
  }
  if (message?.type === "PBT_DISCOVER" && sender.url?.startsWith(chrome.runtime.getURL("")) && Number.isInteger(message.tabId)) {
    // Each matching frame sends a fresh, separate registration response.
    framesByTab.delete(message.tabId);
    chrome.tabs.sendMessage(message.tabId, {type: "PBT_REGISTER"}).catch(() => {});
    setTimeout(() => respond({frames: [...(framesByTab.get(message.tabId)?.values() || [])]}), 350);
    return true;
  }
});
