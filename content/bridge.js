/**
 * WA Contact Extractor — Bridge (Isolated World)
 * Declared in manifest as a content script → runs in ISOLATED world
 * Relays window.postMessage from the MAIN world extractor → chrome.runtime
 */

(function () {
  if (window.__WA_BRIDGE_LOADED__) return;
  window.__WA_BRIDGE_LOADED__ = true;

  /**
   * Safe wrapper — "Extension context invalidated" is thrown when the extension
   * is reloaded/updated while this content script is still alive on the page.
   * We guard every chrome.runtime call to avoid uncaught errors.
   */
  function safeMessage(payload) {
    try {
      // chrome.runtime.id is undefined when the context is invalidated
      if (!chrome?.runtime?.id) return;
      chrome.runtime.sendMessage(payload).catch(() => {});
    } catch (_) {
      // Context invalidated — silently ignore
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (!event.data?.__waExtractor) return;

    const { type, progress, status, data } = event.data;

    if (type === "EXTRACTION_PROGRESS") {
      safeMessage({ type: "EXTRACTION_PROGRESS", progress, status });
    }

    if (type === "EXTRACTION_RESULT") {
      safeMessage({ type: "EXTRACTION_RESULT", data });
    }
  });

  console.log("[WA Bridge] Ready. Listening for extractor messages...");
})();
