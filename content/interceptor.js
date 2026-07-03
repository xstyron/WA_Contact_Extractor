/**
 * WA Contact Extractor — Interceptor (MAIN WORLD, document_start)
 * Strategy 1: Webpack chunk interception (all known names)
 * Strategy 2: React DevTools hook — captures fiber root on every React commit
 */
(function () {
  "use strict";
  if (window.__WA_INTERCEPTOR_LOADED__) return;
  window.__WA_INTERCEPTOR_LOADED__ = true;

  // ── 1. Webpack chunk interception ────────────────────────────────────────
  function hookChunk(arr, name) {
    if (arr.__wa_hooked__) return;
    arr.__wa_hooked__ = true;
    const orig = arr.push.bind(arr);
    arr.push = function (...args) {
      for (const chunk of args) {
        if (!Array.isArray(chunk) || typeof chunk[2] !== "function") continue;
        const rt = chunk[2];
        chunk[2] = function (req) {
          if (!window.__WA_REQUIRE__ && req?.m) {
            window.__WA_REQUIRE__ = req;
            console.log("[WA Interceptor] webpack require captured via", name);
          }
          return rt(req);
        };
      }
      return orig(...args);
    };
  }

  for (const name of ["webpackChunkwhatsapp_web_client","webpackChunkWhatsApp","webpackChunk"]) {
    if (window[name]) { hookChunk(window[name], name); continue; }
    let _v;
    try {
      Object.defineProperty(window, name, {
        configurable: true, enumerable: true,
        get() { return _v; },
        set(v) { _v = v; if (Array.isArray(v)) hookChunk(v, name); }
      });
    } catch (_) {}
  }

  // ── 2. React DevTools hook ───────────────────────────────────────────────
  // Must be set BEFORE React loads. React calls hook.onCommitFiberRoot on render.
  const existingHook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  const hook = {
    isDisabled: false,
    supportsFiber: true,
    renderers: new Map(),
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    inject(renderer) {
      const id = this.renderers.size + 1;
      this.renderers.set(id, renderer);
      window.__WA_REACT_RENDERER__ = renderer;
      console.log("[WA Interceptor] React renderer captured");
    },
    onCommitFiberRoot(id, root) {
      if (!window.__WA_FIBER_ROOT__) {
        window.__WA_FIBER_ROOT__ = root;
        console.log("[WA Interceptor] React fiber root captured");
      }
      // Forward to existing DevTools if present
      existingHook?.onCommitFiberRoot?.(id, root);
    },
  };

  // Merge with existing hook if React DevTools is already installed
  if (existingHook) {
    const origCommit = existingHook.onCommitFiberRoot?.bind(existingHook);
    existingHook.onCommitFiberRoot = function (id, root) {
      if (!window.__WA_FIBER_ROOT__) window.__WA_FIBER_ROOT__ = root;
      origCommit?.(id, root);
    };
  } else {
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
  }

  console.log("[WA Interceptor] Ready (webpack + React hook).");
})();
