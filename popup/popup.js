/**
 * WA Contact Extractor — Popup Controller
 * Manages UI state machine and communicates with content script via service worker
 * Optimized for 10,000+ contacts: paginated table rendering
 */

"use strict";

// ─── State ────────────────────────────────────────────────────────────────────
let allContacts = [];
let filteredContacts = [];
let currentFilter = "all";
let waTabId = null;
let currentPage = 0;
const PAGE_SIZE = 100;

// ─── DOM Refs ─────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const States = {
  notOpen:     $("stateNotOpen"),
  notLoggedIn: $("stateNotLoggedIn"),
  loading:     $("stateLoading"),
  ready:       $("stateReady"),
  extracting:  $("stateExtracting"),
  results:     $("stateResults"),
  error:       $("stateError"),
};

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  bindEvents();
  checkWAStatus();
});

// ─── Event Bindings ───────────────────────────────────────────────────────────
function bindEvents() {
  $("btnOpenWA").addEventListener("click", () => {
    chrome.tabs.create({ url: "https://web.whatsapp.com" });
  });
  $("btnGoToWA").addEventListener("click", () => {
    if (waTabId) chrome.tabs.update(waTabId, { active: true });
    else chrome.tabs.create({ url: "https://web.whatsapp.com" });
  });
  $("btnExtract").addEventListener("click", startExtraction);
  $("btnRetry").addEventListener("click", () => checkWAStatus());
  $("btnReExtract").addEventListener("click", () => {
    showState("ready");
    allContacts = [];
    filteredContacts = [];
    currentPage = 0;
  });

  $("btnCSV").addEventListener("click", () => exportContacts("csv"));
  $("btnJSON").addEventListener("click", () => exportContacts("json"));

  // Debounced search
  let searchTimer;
  $("searchInput").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      currentPage = 0;
      applyFilters();
    }, 250);
  });

  // Group select dropdown change
  $("groupSelect").addEventListener("change", () => {
    currentPage = 0;
    applyFilters();
  });

  // Filter chips
  document.querySelectorAll(".chip").forEach(chip => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".chip").forEach(c => c.classList.remove("chip-active"));
      chip.classList.add("chip-active");
      currentFilter = chip.dataset.filter;
      currentPage = 0;
      applyFilters();
    });
  });

  // Scroll-based pagination inside table wrapper
  const tableWrap = document.querySelector(".table-wrap");
  if (tableWrap) {
    tableWrap.addEventListener("scroll", () => {
      const nearBottom = tableWrap.scrollTop + tableWrap.clientHeight >= tableWrap.scrollHeight - 60;
      if (nearBottom) loadMoreRows();
    });
  }

  chrome.runtime.onMessage.addListener(handleBackgroundMessage);
}

// ─── WA Status Check ─────────────────────────────────────────────────────────
async function checkWAStatus() {
  showState("loading");
  setStatus("checking", "Checking...");

  const response = await sendToBackground({ type: "GET_WA_TAB" });

  if (!response?.found) {
    showState("notOpen");
    setStatus("error", "Not Open");
    return;
  }

  waTabId = response.tabId;

  if (!response.loggedIn) {
    if (response.reason === "loading") {
      showState("loading");
      setStatus("checking", "Loading...");
      setTimeout(checkWAStatus, 2000);
      return;
    }
    showState("notLoggedIn");
    setStatus("error", "Not Logged In");
    return;
  }

  showState("ready");
  setStatus("connected", "Connected");
}

// ─── Extraction ───────────────────────────────────────────────────────────────
async function startExtraction() {
  if (!waTabId) return;
  showState("extracting");
  updateProgress(0, "🔌 Injecting extractor...");

  const res = await sendToBackground({ type: "START_EXTRACTION", tabId: waTabId });
  if (!res?.ok) {
    showError("Could not inject into WhatsApp Web. Please refresh the WhatsApp Web tab and try again.\n\nDetails: " + (res?.error || "Unknown error"));
  }
}

// ─── Message Handler ──────────────────────────────────────────────────────────
function handleBackgroundMessage(message) {
  if (message.type === "PROGRESS_UPDATE") {
    updateProgress(message.progress, message.status);
  }
  if (message.type === "CONTACTS_READY") {
    const data = message.data;
    if (data.error) { showError(data.error); return; }
    allContacts = data.contacts || [];
    renderResults();
  }
}

// ─── Progress ─────────────────────────────────────────────────────────────────
function updateProgress(pct, status) {
  $("progressBar").style.width = pct + "%";
  $("progressPct").textContent = pct + "%";
  $("progressStatus").textContent = status || "";
}

// ─── Results ──────────────────────────────────────────────────────────────────
function renderResults() {
  if (allContacts.length === 0) {
    showError("No contacts found. Make sure WhatsApp Web is fully loaded with your chats open.");
    return;
  }

  showState("results");
  setStatus("connected", "Connected");

  const inGroups = allContacts.filter(c => c.groups?.length > 0).length;
  const blocked  = allContacts.filter(c => c.isBlocked).length;
  const business = allContacts.filter(c => c.isBusiness).length;

  $("statTotal").textContent    = fmt(allContacts.length);
  $("statInGroups").textContent = fmt(inGroups);
  $("statBlocked").textContent  = fmt(blocked);
  $("statBusiness").textContent = fmt(business);

  // Populate groups dropdown dynamically
  const groupSelect = $("groupSelect");
  if (groupSelect) {
    groupSelect.innerHTML = '<option value="">All Groups</option>';
    const uniqueGroups = new Set();
    allContacts.forEach(c => {
      if (c.groups && Array.isArray(c.groups)) {
        c.groups.forEach(g => {
          if (g) uniqueGroups.add(g);
        });
      }
    });
    const sortedGroups = Array.from(uniqueGroups).sort((a, b) => a.localeCompare(b));
    sortedGroups.forEach(groupName => {
      const opt = document.createElement("option");
      opt.value = groupName;
      opt.textContent = groupName;
      groupSelect.appendChild(opt);
    });
  }

  currentFilter = "all";
  document.querySelectorAll(".chip").forEach(c => c.classList.remove("chip-active"));
  $("filterAll").classList.add("chip-active");
  applyFilters();
}

function applyFilters() {
  const query = $("searchInput").value.trim().toLowerCase();

  const selectedGroup = $("groupSelect")?.value || "";

  filteredContacts = allContacts.filter(contact => {
    if (query) {
      const nameMatch  = contact.name?.toLowerCase().includes(query);
      const numMatch   = contact.number?.toLowerCase().includes(query);
      const groupMatch = contact.groups?.some(g => g.toLowerCase().includes(query));
      if (!nameMatch && !numMatch && !groupMatch) return false;
    }
    
    if (selectedGroup) {
      if (!contact.groups || !contact.groups.includes(selectedGroup)) return false;
    }

    switch (currentFilter) {
      case "blocked":  return contact.isBlocked;
      case "groups":   return contact.groups?.length > 0;
      case "business": return contact.isBusiness;
      default:         return true;
    }
  });

  // Update filtered count indicator
  const countEl = $("filteredCount");
  if (countEl) {
    countEl.textContent = filteredContacts.length === allContacts.length
      ? `${fmt(filteredContacts.length)} contacts`
      : `${fmt(filteredContacts.length)} of ${fmt(allContacts.length)} contacts`;
  }

  renderTable(true); // full reset
}

// ─── Paginated Table ──────────────────────────────────────────────────────────
function renderTable(reset = false) {
  const tbody  = $("contactsTbody");
  const empty  = $("emptyState");

  if (reset) {
    tbody.innerHTML = "";
    currentPage = 0;
    // Scroll table back to top
    const tw = document.querySelector(".table-wrap");
    if (tw) tw.scrollTop = 0;
  }

  if (filteredContacts.length === 0) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  const start = currentPage * PAGE_SIZE;
  const end   = Math.min(start + PAGE_SIZE, filteredContacts.length);
  const slice = filteredContacts.slice(start, end);

  const fragment = document.createDocumentFragment();
  for (const contact of slice) {
    fragment.appendChild(buildRow(contact));
  }
  tbody.appendChild(fragment);

  // Update pagination footer
  const pageFooter = $("pageFooter");
  if (pageFooter) {
    const shown = Math.min((currentPage + 1) * PAGE_SIZE, filteredContacts.length);
    pageFooter.textContent = shown < filteredContacts.length
      ? `Showing ${fmt(shown)} of ${fmt(filteredContacts.length)} — scroll down for more`
      : `All ${fmt(filteredContacts.length)} contacts loaded`;
  }

  currentPage++;
}

function loadMoreRows() {
  const alreadyShown = currentPage * PAGE_SIZE;
  if (alreadyShown >= filteredContacts.length) return; // nothing more
  renderTable(false);
}

function buildRow(contact) {
  const tr = document.createElement("tr");

  // Name
  const tdName = document.createElement("td");
  tdName.innerHTML = `<div class="contact-name" title="${escHtml(contact.name)}">${escHtml(contact.name)}</div>`;

  // Number
  const tdNum = document.createElement("td");
  tdNum.innerHTML = `<span class="contact-number">${escHtml(contact.number)}</span>`;

  // Groups
  const tdGroups = document.createElement("td");
  tdGroups.className = "groups-cell";
  if (contact.groups?.length > 0) {
    const visible = contact.groups.slice(0, 2);
    const extra   = contact.groups.length - 2;
    tdGroups.innerHTML = visible.map(g =>
      `<span class="group-tag" title="${escHtml(g)}">${escHtml(truncate(g, 11))}</span>`
    ).join("") + (extra > 0 ? `<span class="group-more">+${extra}</span>` : "");
  } else {
    tdGroups.innerHTML = `<span style="color:var(--text-muted);font-size:11px">—</span>`;
  }

  // Status
  const tdStatus = document.createElement("td");
  if (contact.isBlocked)       tdStatus.innerHTML = `<span class="badge badge-blocked">🚫 Blocked</span>`;
  else if (contact.isBusiness) tdStatus.innerHTML = `<span class="badge badge-business">💼 Biz</span>`;
  else                         tdStatus.innerHTML = `<span class="badge badge-normal">✓ OK</span>`;

  tr.append(tdName, tdNum, tdGroups, tdStatus);
  return tr;
}

// ─── Export ───────────────────────────────────────────────────────────────────
function exportContacts(format) {
  // Respect filters: export only filtered set if search, group select, or status chip is active
  const hasActiveFilters = $("searchInput").value.trim() !== "" || 
                           $("groupSelect").value !== "" || 
                           currentFilter !== "all";
  
  const toExport = hasActiveFilters ? filteredContacts : allContacts;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  if (format === "json") {
    downloadFile(JSON.stringify(toExport, null, 2), `wa_contacts_${timestamp}.json`, "application/json");
    return;
  }

  // CSV — efficient string building for large datasets
  const rows = ['Name,Number,Groups,Blocked,Business,"In My Contacts"'];
  for (const c of toExport) {
    rows.push([
      csvCell(c.name),
      csvCell(c.number),
      csvCell((c.groups || []).join("; ")),
      c.isBlocked  ? "Yes" : "No",
      c.isBusiness ? "Yes" : "No",
      c.isMyContact ? "Yes" : "No",
    ].join(","));
  }
  downloadFile(rows.join("\n"), `wa_contacts_${timestamp}.csv`, "text/csv;charset=utf-8;");
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─── State Machine ────────────────────────────────────────────────────────────
function showState(name) {
  Object.values(States).forEach(el => el?.classList.add("hidden"));
  States[name]?.classList.remove("hidden");
}
function showError(msg) {
  $("errorMsg").textContent = msg;
  showState("error");
  setStatus("error", "Error");
}
function setStatus(type, text) {
  $("statusBadge").className = "status-badge status-" + type;
  $("statusText").textContent = text;
}

// ─── Messaging ────────────────────────────────────────────────────────────────
function sendToBackground(message) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) { console.warn(chrome.runtime.lastError.message); resolve(null); }
      else resolve(response);
    });
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fmt(n) { return n.toLocaleString(); }
function escHtml(s) {
  if (!s) return "";
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function truncate(s, len) { return s?.length > len ? s.slice(0, len) + "…" : (s || ""); }
function csvCell(v) { return `"${String(v ?? "").replace(/"/g,'""')}"`; }
