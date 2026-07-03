/**
 * WA Contact Extractor — Background Service Worker
 * Routes messages between popup <-> content script
 * Handles tab detection and MAIN world injection orchestration
 */

// ─── Message Router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_WA_TAB") {
    getWhatsAppTab().then(sendResponse);
    return true;
  }

  if (message.type === "START_EXTRACTION") {
    injectAndExtract(message.tabId).then(sendResponse);
    return true;
  }

  // Relayed from bridge.js (isolated world) → forward to popup
  if (message.type === "EXTRACTION_RESULT") {
    chrome.runtime.sendMessage({ type: "CONTACTS_READY", data: message.data })
      .catch(() => {}); // popup may have closed
  }

  if (message.type === "EXTRACTION_PROGRESS") {
    chrome.runtime.sendMessage({
      type: "PROGRESS_UPDATE",
      progress: message.progress,
      status: message.status,
    }).catch(() => {});
  }
});

// ─── Tab Detection ────────────────────────────────────────────────────────────
async function getWhatsAppTab() {
  try {
    const tabs = await chrome.tabs.query({ url: "https://web.whatsapp.com/*" });
    if (!tabs.length) return { found: false, reason: "no_tab" };

    const waTab = tabs[0];
    const results = await chrome.scripting.executeScript({
      target: { tabId: waTab.id },
      func: checkLoginState,
      world: "ISOLATED",
    });

    const loginState = results?.[0]?.result ?? { loggedIn: false, reason: "unknown" };
    return { found: true, tabId: waTab.id, ...loginState };
  } catch (err) {
    return { found: false, reason: "error", error: err.message };
  }
}

function checkLoginState() {
  const hasQR = !!document.querySelector('[data-testid="qrcode"], canvas[aria-label*="Scan"], div[data-ref]');
  const hasChatList = !!document.querySelector('[data-testid="chat-list"], #pane-side, div[aria-label="Chat list"]');
  const isLoading = document.readyState !== "complete" || document.title.toLowerCase().includes("loading");

  if (hasChatList)             return { loggedIn: true };
  if (isLoading && !hasChatList) return { loggedIn: false, reason: "loading" };
  if (hasQR)                   return { loggedIn: false, reason: "qr_code" };
  return { loggedIn: false, reason: "unknown" };
}

// ─── Inject extractor.js into MAIN world then trigger extraction ──────────────
async function injectAndExtract(tabId) {
  try {
    // Inject bridge first (isolated world — safe to re-inject, it's guarded)
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/bridge.js"],
      world: "ISOLATED",
    });

    // Inject extractor into MAIN world so it can access window.webpackChunk...
    // extractor.js auto-starts on injection (no event dispatch needed)
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/extractor.js"],
      world: "MAIN",
    });

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
