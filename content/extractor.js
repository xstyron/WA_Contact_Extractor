/**
 * WA Contact Extractor — MAIN WORLD Script
 * Injected on-demand when the user clicks "Extract".
 *
 * STRATEGY 0: Direct IndexedDB scan ('model-storage' and other DBs)
 * STRATEGY 1: window.__WA_REQUIRE__ (webpack, captured by interceptor)
 * STRATEGY 2: React fiber traversal (window.__WA_FIBER_ROOT__ or DOM nodes)
 */
(function () {
  "use strict";

  if (window.__WA_EXTRACTOR_MAIN_LOADED__) { runExtraction(); return; }
  window.__WA_EXTRACTOR_MAIN_LOADED__ = true;

  function sendProgress(pct, status) {
    window.postMessage({ __waExtractor: true, type: "EXTRACTION_PROGRESS", progress: pct, status }, "*");
  }
  function sendResult(data) {
    window.postMessage({ __waExtractor: true, type: "EXTRACTION_RESULT", data }, "*");
  }
  function yieldToMain() { return new Promise(r => setTimeout(r, 0)); }

  function cleanNumber(rawNum) {
    if (!rawNum) return "";
    const digits = rawNum.replace(/\D/g, "");
    return digits.length >= 10 ? digits.slice(-10) : digits;
  }

  function parseJID(p) {
    if (!p) return null;
    if (typeof p === "string") return p;
    if (typeof p === "object") {
      const idVal = p.id || p.jid || p.key?.remoteJid;
      if (idVal) {
        if (typeof idVal === "string") return idVal;
        if (typeof idVal === "object" && idVal._serialized) return idVal._serialized;
        if (typeof idVal === "object" && idVal.user && idVal.server) return `${idVal.user}@${idVal.server}`;
      }
      if (p._serialized) return p._serialized;
      if (p.user && p.server) return `${p.user}@${p.server}`;
    }
    return null;
  }

  // ── Helper: Read IndexedDB Store ──────────────────────────────────────────
  function readStoreData(db, storeName) {
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, "readonly");
        const store = tx.objectStore(storeName);
        const req = store.getAll();
        req.onsuccess = (e) => resolve(e.target.result || []);
        req.onerror = () => resolve([]);
      } catch (_) {
        resolve([]);
      }
    });
  }

  // ── STRATEGY 0: IndexedDB Scraper ─────────────────────────────────────────
  async function extractFromDBName(dbName) {
    return new Promise((resolve) => {
      try {
        console.log(`[WA Extractor] Opening IndexedDB: ${dbName}`);
        const request = indexedDB.open(dbName);
        request.onerror = () => resolve(null);
        request.onsuccess = async (e) => {
          const db = e.target.result;
          const stores = Array.from(db.objectStoreNames);
          console.log(`[WA Extractor] Opened ${dbName}. Stores:`, stores);

          const contactStoreName = stores.find(s => s.toLowerCase() === "contact" || s.toLowerCase() === "contacts");
          const chatStoreName = stores.find(s => s.toLowerCase() === "chat" || s.toLowerCase() === "chats");
          const groupMetaStoreName = stores.find(s => s.toLowerCase().includes("group-metadata") || s.toLowerCase().includes("groupmetadata"));

          if (!contactStoreName) {
            db.close();
            resolve(null);
            return;
          }

          try {
            sendProgress(10, `Reading local DB (${dbName})...`);
            const contacts = await readStoreData(db, contactStoreName);
            const chats = chatStoreName ? await readStoreData(db, chatStoreName) : [];
            const groupMetadata = groupMetaStoreName ? await readStoreData(db, groupMetaStoreName) : [];

            console.log(`[WA Extractor] Retrieved from DB ${dbName}: ${contacts.length} contacts, ${chats.length} chats, ${groupMetadata.length} group metadata`);

            if (!contacts.length) {
              db.close();
              resolve(null);
              return;
            }

            const contactMap = {};
            for (const c of contacts) {
              if (!c) continue;
              const serial = parseJID(c);

              if (!serial || serial.endsWith("@g.us") || serial.includes("@broadcast")) continue;
              const rawNum = serial.split("@")[0];
              if (!rawNum || rawNum.length < 5) continue;

              contactMap[serial] = {
                id: serial,
                name: c.name || c.pushname || c.displayName || c.verifiedName || c.formattedName || rawNum,
                number: cleanNumber(rawNum),
                rawNumber: rawNum,
                isBlocked: !!(c.isBlocked || c.blocked),
                isBusiness: !!c.isBusiness,
                isMyContact: !!c.isMyContact,
                groups: []
              };
            }

            // Map groups from chats
            if (chats.length) {
              const groupChats = chats.filter(ch => ch && (ch.id || "").endsWith("@g.us"));
              for (const chat of groupChats) {
                const groupName = chat.name || chat.formattedTitle || chat.subject || "Unnamed Group";
                const participants = chat.groupMetadata?.participants || chat.participants || [];
                const partsList = Array.isArray(participants) ? participants : [];
                for (const p of partsList) {
                  const pid = parseJID(p);
                  if (pid && contactMap[pid]) {
                    if (!contactMap[pid].groups.includes(groupName)) {
                      contactMap[pid].groups.push(groupName);
                    }
                  }
                }
              }
            }

            // Map groups from groupMetadata
            if (groupMetadata.length) {
              for (const g of groupMetadata) {
                if (!g) continue;
                const gid = parseJID(g);
                if (!gid || !gid.endsWith("@g.us")) continue;

                let groupName = "Unnamed Group";
                if (chats.length) {
                  const foundChat = chats.find(c => c && (c.id === gid || c.id?._serialized === gid || parseJID(c) === gid));
                  if (foundChat) {
                    groupName = foundChat.name || foundChat.formattedTitle || foundChat.subject || groupName;
                  }
                }

                const participants = g.participants || [];
                for (const p of participants) {
                  const pid = parseJID(p);
                  if (pid && contactMap[pid]) {
                    if (!contactMap[pid].groups.includes(groupName)) {
                      contactMap[pid].groups.push(groupName);
                    }
                  }
                }
              }
            }

            db.close();
            resolve(contactMap);
          } catch (err) {
            console.error(`[WA Extractor] Error processing DB ${dbName}:`, err);
            db.close();
            resolve(null);
          }
        };
      } catch (err) {
        resolve(null);
      }
    });
  }

  async function extractViaIndexedDB() {
    try {
      // 1. Try known "model-storage" database
      const result = await extractFromDBName("model-storage");
      if (result && Object.keys(result).length > 0) return result;

      // 2. Scan all other databases listed on origin
      const dbs = await indexedDB.databases();
      console.log("[WA Extractor] Found databases:", dbs.map(d => d.name));
      for (const d of dbs) {
        if (d.name && d.name !== "model-storage") {
          const res = await extractFromDBName(d.name);
          if (res && Object.keys(res).length > 0) return res;
        }
      }
    } catch (err) {
      console.error("[WA Extractor] Database scanner failed:", err);
    }
    return null;
  }

  // ── Webpack and React Model Getters ───────────────────────────────────────
  function getModels(c) {
    if (!c || typeof c !== "object") return null;
    try { const r = c.getModelsArray?.(); if (Array.isArray(r) && r.length) return r; } catch (_) {}
    if (Array.isArray(c.models) && c.models.length) return c.models;
    if (Array.isArray(c.list)   && c.list.length)   return c.list;
    try { const r = c.toArray?.(); if (Array.isArray(r) && r.length) return r; } catch (_) {}
    try { if (typeof c.values === "function") { const r = [...c.values()]; if (r.length) return r; } } catch (_) {}
    return null;
  }

  function looksLikeContact(obj) {
    if (!obj || typeof obj !== "object") return false;
    const s = obj.id?._serialized || (typeof obj.id === "string" ? obj.id : "");
    if (s.endsWith("@c.us") || s.endsWith("@s.whatsapp.net")) return true;
    if (obj.id?.user && (obj.id?.server === "c.us" || obj.id?.server === "s.whatsapp.net")) return true;
    return false;
  }
  function looksLikeChat(obj) {
    const s = obj?.id?._serialized || (typeof obj?.id === "string" ? obj.id : "");
    return (s.endsWith("@c.us") || s.endsWith("@g.us")) &&
           (typeof obj.t === "number" || typeof obj.unreadCount === "number");
  }

  // ── STRATEGY 1: Webpack Require ───────────────────────────────────────────
  function getRequireFn() {
    if (window.__WA_REQUIRE__?.m || window.__WA_REQUIRE__?.c) return window.__WA_REQUIRE__;
    for (const k of Object.getOwnPropertyNames(window)) {
      try {
        const v = window[k];
        if (typeof v === "function" && v.m && v.c && typeof v.d === "function") return v;
      } catch (_) {}
    }
    return null;
  }

  async function findCollectionsInRequire(req) {
    let Contact = null, Chat = null;
    const entries = Object.values(req.c || {});
    for (const cached of entries) {
      const mod = cached?.exports;
      if (!mod || typeof mod !== "object") continue;
      for (const c of [mod, mod.default, ...Object.values(mod)].filter(v => v && typeof v === "object")) {
        const arr = getModels(c);
        if (!arr || arr.length < 2) continue;
        const s = arr.slice(0, 8);
        if (!Contact && s.some(looksLikeContact)) Contact = c;
        if (!Chat && c !== Contact && s.some(looksLikeChat)) Chat = c;
      }
      if (Contact && Chat) break;
    }
    return { Contact, Chat };
  }

  // ── STRATEGY 2: React Fiber ───────────────────────────────────────────────
  function getFiberRoot() {
    if (window.__WA_FIBER_ROOT__) return window.__WA_FIBER_ROOT__;
    const selectors = ["#app", "#root", "div[data-testid='app-wrapper']", "body > div"];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const key = Object.keys(el).find(k => k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance"));
      if (key) return { current: el[key] };
    }
    return null;
  }

  async function extractFromFiber(fiberRoot) {
    const contactMap = {};
    const chatMap = {};
    const seen = new WeakSet();
    let scanned = 0;

    function scanValue(val, depth) {
      if (!val || typeof val !== "object" || depth > 4 || seen.has(val)) return;
      try { seen.add(val); } catch (_) { return; }

      const arr = getModels(val);
      if (arr && arr.length > 2) {
        const sample = arr.slice(0, 8);
        if (sample.some(looksLikeContact)) {
          for (const c of arr) {
            try {
              const serial = parseJID(c);
              if (!serial || serial.endsWith("@g.us") || serial.includes("@broadcast")) continue;
              const rawNum = c.id?.user || serial.split("@")[0];
              if (!rawNum || rawNum.length < 5) continue;
              contactMap[serial] = {
                id: serial,
                name: c.name || c.pushname || c.notify || c.verifiedName || rawNum,
                number: cleanNumber(rawNum),
                rawNumber: rawNum,
                isBlocked: !!(c.isBlocked || c.blocked),
                isBusiness: !!c.isBusiness,
                isMyContact: !!c.isMyContact,
                groups: [],
              };
            } catch (_) {}
          }
        }
        if (sample.some(looksLikeChat)) {
          for (const ch of arr) {
            try {
              const s = ch.id?._serialized || "";
              if (!s.endsWith("@g.us")) continue;
              chatMap[s] = { name: ch.name || ch.formattedTitle || "Unnamed Group", chat: ch };
            } catch (_) {}
          }
        }
        return;
      }

      if (depth < 3) {
        for (const k of Object.keys(val)) {
          try { scanValue(val[k], depth + 1); } catch (_) {}
        }
      }
    }

    async function traverseFiber(fiber, depth) {
      if (!fiber || depth > 500 || seen.has(fiber)) return;
      try { seen.add(fiber); } catch (_) { return; }
      scanned++;

      let state = fiber.memoizedState;
      let hops = 0;
      while (state && hops++ < 30) {
        try { scanValue(state.memoizedState, 0); } catch (_) {}
        state = state.next;
      }

      try { if (fiber.memoizedProps?.value) scanValue(fiber.memoizedProps.value, 0); } catch (_) {}

      if (scanned % 200 === 0) {
        sendProgress(40 + Math.min(scanned / 20, 30), `🔬 Scanning React tree... (${scanned} nodes)`);
        await yieldToMain();
      }

      if (fiber.child)   await traverseFiber(fiber.child, depth + 1);
      if (fiber.sibling) await traverseFiber(fiber.sibling, depth);
    }

    sendProgress(35, "🔬 Traversing React component tree...");
    await traverseFiber(fiberRoot.current, 0);

    return { contactMap, chatMap };
  }

  // ── Common Post-Processing ───────────────────────────────────────────────
  async function processAndSend(contactMap, chatMap, ChatCollection) {
    sendProgress(80, "👥 Mapping groups...");
    await yieldToMain();

    const chatSource = ChatCollection ? (getModels(ChatCollection) || []) : [];
    const groupChats = chatSource.filter(c => (c.id?._serialized || "").endsWith("@g.us"));

    for (const chat of groupChats) {
      try {
        const name = chat.name || chat.formattedTitle || "Unnamed Group";
        const meta = chat.groupMetadata;
        if (!meta) continue;
        const parts = getModels(meta.participants) ||
                      Array.from(meta.participants?.models || meta.participants || []);
        for (const p of parts) {
          const pid = parseJID(p);
          if (!pid || !contactMap[pid]) continue;
          if (!contactMap[pid].groups.includes(name)) contactMap[pid].groups.push(name);
        }
      } catch (_) {}
    }

    for (const [gid, { name, chat }] of Object.entries(chatMap)) {
      try {
        const meta = chat.groupMetadata;
        if (!meta) continue;
        const parts = getModels(meta.participants) ||
                      Array.from(meta.participants?.models || meta.participants || []);
        for (const p of parts) {
          const pid = parseJID(p);
          if (!pid || !contactMap[pid]) continue;
          if (!contactMap[pid].groups.includes(name)) contactMap[pid].groups.push(name);
        }
      } catch (_) {}
    }

    const contacts = Object.values(contactMap)
      .filter(c => c.rawNumber?.length >= 5)
      .sort((a, b) => a.name.localeCompare(b.name));

    sendProgress(100, `✅ ${contacts.length.toLocaleString()} contacts extracted!`);
    console.log("[WA Extractor] Final Contacts:", contacts.length);
    sendResult({ contacts, total: contacts.length });
  }

  // ── Main Controller ───────────────────────────────────────────────────────
  async function runExtraction() {
    try {
      sendProgress(5, "🔍 Initiating extraction database query...");
      await yieldToMain();

      // STRATEGY 0: IndexedDB
      const dbContacts = await extractViaIndexedDB();
      if (dbContacts && Object.keys(dbContacts).length > 0) {
        console.log("[WA Extractor] Strategy 0 (IndexedDB) Succeeded!");
        return await processAndSend(dbContacts, {}, null);
      }

      // STRATEGY 1: Webpack require
      console.log("[WA Extractor] Strategy 0 failed. Trying Strategy 1 (Webpack Interception)...");
      sendProgress(20, "📦 Accessing internal modules...");
      await yieldToMain();

      const req = getRequireFn();
      if (req) {
        const { Contact, Chat } = await findCollectionsInRequire(req);
        if (Contact) {
          console.log("[WA Extractor] Strategy 1 (Webpack) Succeeded!");
          const models = getModels(Contact) || [];
          const CHUNK = 500;
          const contactMap = {};
          for (let i = 0; i < models.length; i += CHUNK) {
            for (const c of models.slice(i, i + CHUNK)) {
              try {
                const serial = parseJID(c);
                if (!serial || serial.endsWith("@g.us") || serial.includes("@broadcast")) continue;
                const rawNum = c.id?.user || serial.split("@")[0];
                if (!rawNum || rawNum.length < 5) continue;
                contactMap[serial] = {
                  id: serial, name: c.name || c.pushname || c.notify || c.verifiedName || rawNum,
                  number: cleanNumber(rawNum), rawNumber: rawNum,
                  isBlocked: !!(c.isBlocked || c.blocked), isBusiness: !!c.isBusiness,
                  isMyContact: !!c.isMyContact, groups: [],
                };
              } catch (_) {}
            }
            sendProgress(20 + Math.round(((i + CHUNK) / models.length) * 50), `👤 Parsing ${Math.min(i + CHUNK, models.length).toLocaleString()} / ${models.length.toLocaleString()}`);
            await yieldToMain();
          }
          return await processAndSend(contactMap, {}, Chat);
        }
      }

      // STRATEGY 2: React fiber
      console.log("[WA Extractor] Strategy 1 failed. Trying Strategy 2 (React Fiber)...");
      sendProgress(30, "⚛️ Accessing React components...");
      await yieldToMain();

      const fiberRoot = getFiberRoot();
      if (!fiberRoot) {
        sendResult({
          error: "Could not access WhatsApp's internal database or React tree.\n\n" +
                 "Please perform a complete reload:\n" +
                 "1. Open chrome://extensions, locate WA Extractor and click ↻\n" +
                 "2. Go back to WhatsApp Web and press Ctrl+R to reload the tab\n" +
                 "3. Wait for all chats to fully load\n" +
                 "4. Click Extract again"
        });
        return;
      }

      const { contactMap, chatMap } = await extractFromFiber(fiberRoot);
      if (Object.keys(contactMap).length > 0) {
        console.log("[WA Extractor] Strategy 2 (React Fiber) Succeeded!");
        return await processAndSend(contactMap, chatMap, null);
      }

      sendResult({
        error: "All extraction strategies returned empty records.\n\n" +
               "Please ensure you are fully logged in and all chats have loaded before clicking Extract."
      });

    } catch (err) {
      console.error("[WA Extractor] Fatal error in execution:", err);
      sendResult({ error: "Unexpected extraction error: " + (err?.message || String(err)) });
    }
  }

  window.addEventListener("WA_EXTRACTOR_START", runExtraction);
  runExtraction();
  console.log("[WA Extractor] Loaded. Strategies: IndexedDB -> Webpack -> React Fiber.");
})();
