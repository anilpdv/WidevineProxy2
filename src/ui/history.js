import { renderKeyEntry, entriesFromMap, normalizeType, manifests, searchText } from "./keys-render.js";

const root = document.documentElement;
const listEl = document.getElementById("history-list");
const searchEl = document.getElementById("search");
const typeFilterEl = document.getElementById("typeFilter");
const tabFilterEl = document.getElementById("tabFilter");
const clearAllBtn = document.getElementById("clearAll");
const exportBtn = document.getElementById("exportAll");
const totalCountEl = document.getElementById("totalCount");
const resultCountEl = document.getElementById("resultCount");

function deleteEntry(pssh) {
    if (pssh) chrome.storage.local.remove(pssh, loadKeys);
}

let entries = [];
let settings = {};
let query = "";
let typeFilter = "all";

const urlParams = new URLSearchParams(window.location.search);
const targetTabId = urlParams.has("tabId") ? parseInt(urlParams.get("tabId"), 10) : null;
let tabFilter = targetTabId !== null ? "current" : "all";

if (targetTabId !== null) {
    tabFilterEl.style.display = "flex";
}

function matches(entry) {
    if (tabFilter === "current" && targetTabId !== null && entry.tabId !== targetTabId) {
        return false;
    }
    const type = normalizeType((manifests(entry)[0] || {}).type);
    if (typeFilter !== "all" && type !== typeFilter)
        return false;
    return !(query && searchText(entry).indexOf(query) === -1);
}

function render() {
    const shown = entries.filter(matches);
    listEl.innerHTML = "";

    totalCountEl.textContent =
        entries.length + " entr" + (entries.length === 1 ? "y" : "ies") + " stored";

    if (!entries.length) {
        resultCountEl.textContent = "";
        listEl.innerHTML = '<div class="hist-empty">No keys have been captured yet.</div>';
        return;
    }

    resultCountEl.innerHTML = "Showing <b>" + shown.length + "</b> of " + entries.length;

    if (!shown.length) {
        listEl.innerHTML = '<div class="hist-empty">No entries match your search.</div>';
        return;
    }

    shown.forEach((e) => listEl.append(renderKeyEntry(e, settings, (pssh) => deleteEntry(pssh))));
}

function loadKeys() {
    chrome.storage.local.get(null, (map) => {
        entries = entriesFromMap(map);
        render();
    });
}

function loadSettings(cb) {
    chrome.storage.sync.get(null, (s) => {
        settings = s || {};
        root.setAttribute("data-theme", settings.dark_mode ? "dark" : "light");
        cb && cb();
    });
}

// Search
searchEl.addEventListener("input", () => {
    query = searchEl.value.trim().toLowerCase();
    render();
});

// Tab filter
if (tabFilterEl) {
    tabFilterEl.addEventListener("click", (e) => {
        const btn = e.target.closest(".filter-btn");
        if (!btn) return;
        tabFilter = btn.dataset.tab;
        tabFilterEl.querySelectorAll(".filter-btn").forEach((b) =>
            b.classList.toggle("active", b === btn)
        );
        render();
    });
}

// Type filter
typeFilterEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".filter-btn");
    if (!btn)
        return;
    typeFilter = btn.dataset.type;
    typeFilterEl.querySelectorAll(".filter-btn").forEach((b) =>
        b.classList.toggle("active", b === btn)
    );
    render();
});

exportBtn.addEventListener("click", () => {
    const exportData = {};
    entries.filter(matches).forEach(e => {
        exportData[e.pssh_data] = e;
    });
    const blob = new Blob([JSON.stringify(exportData, null, 4)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "widevineproxy2-keys.json";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
});

clearAllBtn.addEventListener("click", () => {
    const shown = entries.filter(matches);
    if (!shown.length) return;

    const msg = shown.length === entries.length
        ? "Delete all " + entries.length + " stored key entries?"
        : "Delete the " + shown.length + " currently filtered key entries?";

    if (!window.confirm(msg)) return;

    if (shown.length === entries.length) {
        chrome.storage.local.clear(() => { entries = []; render(); });
    } else {
        const keysToRemove = shown.map(e => e.pssh_data);
        chrome.storage.local.remove(keysToRemove, () => {
            loadKeys();
        });
    }
});

// Live-update while the page is open.
function onStorageChanged(changes, areaName) {
    if (areaName === "local") loadKeys();
    else if (areaName === "sync") loadSettings(render);
}

function isolateZoom() {
    if (typeof chrome === "undefined" || !chrome.tabs || !chrome.tabs.getCurrent)
        return;
    chrome.tabs.getCurrent((tab) => {
        if (chrome.runtime.lastError || !tab || tab.id == null)
            return;
        chrome.tabs.setZoom(tab.id, 0, () => {
            if (chrome.runtime.lastError)
                return;
            chrome.tabs.setZoomSettings(tab.id, { scope: "per-tab" });
        });
    });
}

function boot() {
    if (typeof chrome !== "undefined" && chrome.storage) {
        isolateZoom();
        chrome.storage.onChanged.addListener(onStorageChanged);
        loadSettings(loadKeys);
    } else {
        render();
    }
}

//window.__boot = boot;
boot();
