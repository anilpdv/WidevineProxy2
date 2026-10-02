import { ICON_DOWNLOAD, ICON_TRASH } from "./icons.js";
import { renderKeyEntry, entriesFromMap, refreshCommands } from "./keys-render.js";

const root = document.documentElement;
const darkToggle = document.getElementById("darkModeToggle");
const enabled = document.getElementById("enabled");
const statePill = document.getElementById("statePill");
const stateText = document.getElementById("stateText");
const wvdSelect = document.getElementById("wvd_select");
const remoteSelect = document.getElementById("remote_select");
const wvdPanel = document.getElementById("wvd");
const remotePanel = document.getElementById("remote");
let booting = true;
let settings = {};

(async () => {
    const el = document.getElementById("version");
    if (!el)
        return;

    let version = "";
    try {
        version = chrome.runtime.getManifest().version;
    } catch (e) {}

    if (version)
        el.textContent = "v" + version;
})();

function saveSync(obj) {
    if (booting) return;
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.sync) {
        chrome.storage.sync.set(obj);
    }
    Object.assign(settings, obj);
}

function applyTheme(dark) {
    root.setAttribute("data-theme", dark ? "dark" : "light");
    darkToggle.checked = dark;
}

const autoNextToggle = document.getElementById("autoNextToggle");
const autoNextConfig = document.getElementById("autoNextConfig");
const autoNextSelector = document.getElementById("autoNextSelector");
const autoNextPick = document.getElementById("autoNextPick");

applyTheme(false);
darkToggle.addEventListener("change", () => {
    applyTheme(darkToggle.checked);
    saveSync({ dark_mode: darkToggle.checked });
});

autoNextPick.addEventListener("click", async () => {
    if (typeof chrome !== "undefined" && chrome.tabs) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
            chrome.tabs.sendMessage(tab.id, { type: "START_PICKER" });
            window.close();
        }
    }
});

function applyAutoNext() {
    autoNextConfig.style.display = autoNextToggle.checked ? "flex" : "none";
}

autoNextToggle.addEventListener("change", () => {
    applyAutoNext();
    saveSync({ auto_next: autoNextToggle.checked });
});

autoNextSelector.addEventListener("input", () => {
    saveSync({ auto_next_selector: autoNextSelector.value });
});

document.getElementById("autoNextSkip").addEventListener("input", (e) => {
    const val = parseInt(e.target.value, 10);
    saveSync({ auto_next_skip: isNaN(val) ? 0 : val });
});

// --- Service certificate (false = never, true = when used) ---
const certNever = document.getElementById("cert_never");
const certWhen = document.getElementById("cert_when");

function setServerCert(on) {
    certWhen.checked = on;
    certNever.checked = !on;
}

const onServerCertChange = () => saveSync({ server_cert: certWhen.checked });
[certNever, certWhen].forEach((r) => r.addEventListener("change", onServerCertChange));

// --- Proxy mode (event / property) ---
const proxyEvent = document.getElementById("proxy_event");
const proxyProperty = document.getElementById("proxy_property");

function setProxyMode(mode) {
    proxyProperty.checked = mode === "property";
    proxyEvent.checked = !proxyProperty.checked;
}

const currentProxyMode = () => (proxyProperty.checked ? "property" : "event");
const onProxyModeChange = () => { saveSync({ proxy_mode: currentProxyMode() }); applyCompat(); };
[proxyEvent, proxyProperty].forEach((r) => r.addEventListener("change", onProxyModeChange));

function applyEnabled() {
    const on = enabled.checked;
    statePill.classList.toggle("on", on);
    stateText.textContent = on ? "enabled" : "disabled";
}

enabled.addEventListener("change", () => {
    applyEnabled();
    saveSync({ enabled: enabled.checked });
});
applyEnabled();

// --- Device type (Widevine Device / Remote CDM) shows one panel at a time ---
function applyDeviceType() {
    const showWvd = wvdSelect.checked;
    const showRemote = remoteSelect.checked;
    const none = !showWvd && !showRemote;
    wvdPanel.style.display = none || showWvd ? "" : "none";
    remotePanel.style.display = none || showRemote ? "" : "none";
}

function onDeviceTypeChange() {
    applyDeviceType();
    saveSync({ device_type: wvdSelect.checked ? "WVD" : "REMOTE" });
    applyCompat();
}

wvdSelect.addEventListener("change", onDeviceTypeChange);
remoteSelect.addEventListener("change", onDeviceTypeChange);
applyDeviceType();

// --- Property proxy mode is incompatible with Remote CDM
const proxyPropertyLabel = document.querySelector('label[for="proxy_property"]');
const remoteSelectLabel = document.querySelector('label[for="remote_select"]');
const INCOMPAT_MSG = "Property proxy mode is incompatible with Remote CDM";

function applyCompat() {
    // Resolve a stored impossible combo (Remote CDM + Property): drop Property.
    if (remoteSelect.checked && proxyProperty.checked) {
        setProxyMode("event");
        saveSync({ proxy_mode: "event" });
    }
    const disableProperty = remoteSelect.checked; // Remote selected -> no Property
    const disableRemote = proxyProperty.checked;  // Property selected -> no Remote

    proxyProperty.disabled = disableProperty;
    proxyPropertyLabel.classList.toggle("disabled", disableProperty);
    proxyPropertyLabel.title = disableProperty ? INCOMPAT_MSG : "";

    remoteSelect.disabled = disableRemote;
    remoteSelectLabel.classList.toggle("disabled", disableRemote);
    remoteSelectLabel.title = disableRemote ? INCOMPAT_MSG : "";
}

applyCompat();

// --- Packager toggle (mp4decrypt / shaka-packager) ---
const pkgMp4 = document.getElementById("pkg_mp4");
const pkgShaka = document.getElementById("pkg_shaka");

function setPackager(shaka) {
    pkgShaka.checked = shaka;
    pkgMp4.checked = !shaka;
}

const onPackagerChange = () => { saveSync({ use_shaka: pkgShaka.checked }); refreshCommands(); };
pkgMp4.addEventListener("change", onPackagerChange);
pkgShaka.addEventListener("change", onPackagerChange);

// --- Quotes toggle (cmd / bash) ---
const quoteCmd = document.getElementById("quote_cmd");
const quoteBash = document.getElementById("quote_bash");

function setQuotes(bash) {
    quoteBash.checked = bash;
    quoteCmd.checked = !bash;
}

const onQuotesChange = () => { saveSync({ use_single_quotes: quoteBash.checked }); refreshCommands(); };
quoteCmd.addEventListener("change", onQuotesChange);
quoteBash.addEventListener("change", onQuotesChange);

// --- Save-name toggle (don't / from title / from url) ---
const saveNone = document.getElementById("save_none");
const saveTitle = document.getElementById("save_title");
const saveUrl = document.getElementById("save_url");

function setSaveName(mode) {
    saveTitle.checked = mode === "title";
    saveUrl.checked = mode === "url";
    saveNone.checked = !saveTitle.checked && !saveUrl.checked;
}

const currentSaveName = () => (saveTitle.checked ? "title" : saveUrl.checked ? "url" : "none");
const onSaveNameChange = () => { saveSync({ save_name: currentSaveName() }); refreshCommands(); };
[saveNone, saveTitle, saveUrl].forEach((r) => r.addEventListener("change", onSaveNameChange));

// --- Collapsible Command Options ---
const cmdSection = document.getElementById("command-options");
cmdSection.querySelector(".collapse-head").addEventListener("click", () => {
    const collapsed = cmdSection.classList.toggle("collapsed");
    saveSync({ command_options_collapsed: collapsed });
});

// --- EME status -------------------------------------------
const drmStatusEl = document.getElementById("drmStatus");

function setEmeStatusField(cell, st) {
    cell.classList.remove("ok", "fail", "pending");
    if (!st) {
        cell.classList.add("pending");
        cell.title = cell.dataset.eme + " - waiting";
    } else {
        cell.classList.add(st.success ? "ok" : "fail");
        cell.title = cell.dataset.eme + (st.success ? " - success" : " - failed") +
            (st.args !== undefined ? "\n" + st.args : "");
    }
}

async function refreshEmeStatuses(tabId) {
    let statuses;
    try {
        statuses = await chrome.tabs.sendMessage(tabId, { type: "EME_STATUS_ACTIVE" });
    } catch (e) {
        return;
    }
    if (!statuses || Object.keys(statuses).length === 0)
        return;

    drmStatusEl.querySelectorAll(".drm-step").forEach((cell) => {
        const st = statuses[cell.dataset.eme];
        setEmeStatusField(cell, st);
    });
}

function listenEmeStatus(tabId) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (sender.tab?.id !== tabId)
            return;
        if (message.type !== "EME_STATUS_REACTIVE")
            return;

        const payload = message.payload;
        const cell = drmStatusEl.querySelector(`.drm-step[data-eme="${payload.type}"]`);
        setEmeStatusField(cell, payload.data);
    });
}

// --- Outdated warning -------------------------------------------------
const outdatedWarn = document.getElementById("outdatedWarn");

async function checkOutdated() {
    try {
        const isOutdated = await chrome.runtime.sendMessage({ type: "IS_OUTDATED" });
        outdatedWarn.hidden = !isOutdated;
    } catch (e) {}
}

// --- Text inputs ---
const exeName = document.getElementById("downloader-name");
const addArgs = document.getElementById("downloader-args");
exeName.addEventListener("input", () => saveSync({ exe_name: exeName.value }));
addArgs.addEventListener("input", () => saveSync({ additional_args: addArgs.value }));

// --- Comboboxes (native <select>s driven by the custom dropdown) ---
const wvdCombo = document.getElementById("wvd-combobox");
const remoteCombo = document.getElementById("remote-combobox");
wvdCombo.addEventListener("change", () => saveSync({ selected: wvdCombo.value }));
remoteCombo.addEventListener("change", () => saveSync({ selected_remote_cdm: remoteCombo.value }));

function populateSelect(sel, names, selected) {
    sel.innerHTML = "";
    (names || []).forEach((n) => {
        const o = document.createElement("option");
        o.value = n;
        o.textContent = n;
        sel.append(o);
    });
    if (selected != null) sel.value = selected;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
}

// --- Device/remote actions (wired straight to the dropdown glyphs) ----
const comboFor = (kind) => (kind === "wvd" ? wvdCombo : remoteCombo);

function openPicker(kind) {
    const mobile = "ontouchstart" in window || navigator.maxTouchPoints > 0;
    const type = {
        wvd: mobile ? "OPEN_PICKER_WVD_MOBILE" : "OPEN_PICKER_WVD",
        remote: mobile ? "OPEN_PICKER_REMOTE_MOBILE" : "OPEN_PICKER_REMOTE",
    }[kind];
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type });
    }
    window.close();
}

const sanitize = (s) => (s || "file").replace(/[\\/:*?"<>|]+/g, "_");

function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// WVD entries are stored as base64 of the binary; remote CDMs as JSON objects.
function downloadEntry(kind, name) {
    const data = settings[name];
    if (!name || data == null) return;
    if (kind === "wvd") {
        const bin = atob(data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        saveBlob(new Blob([bytes], { type: "application/octet-stream" }), sanitize(name) + ".wvd");
    } else {
        saveBlob(new Blob([JSON.stringify(data, null, 4)], { type: "application/json" }), sanitize(name) + ".json");
    }
}

function removeEntry(kind, name) {
    if (!name) return;
    const listKey = kind === "wvd" ? "devices" : "remote_cdms";
    const selKey = kind === "wvd" ? "selected" : "selected_remote_cdm";
    const list = (settings[listKey] || []).filter((n) => n !== name);
    const patch = { [listKey]: list };
    if (settings[selKey] === name) patch[selKey] = list[0] || "";
    delete settings[name];
    Object.assign(settings, patch);
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.sync) {
        chrome.storage.sync.set(patch);
        chrome.storage.sync.remove(name); // drop the stored blob/object
    }
    populateSelect(comboFor(kind), list, patch[selKey] !== undefined ? patch[selKey] : settings[selKey]);
}

const closers = []; // close callbacks for every dropdown

function glyph(kind, title) {
    const el = document.createElement("span");
    el.className = "dd-glyph " + (kind === "dl" ? "dl" : "rm");
    el.title = title;
    el.innerHTML = kind === "dl" ? ICON_DOWNLOAD : ICON_TRASH;
    return el;
}

function initDropdown(host) {
    const select = host.querySelector('[data-role="select"]');
    const kind = host.dataset.kind; // "wvd" | "remote"
    const addLabel = host.dataset.addLabel || "Choose file";
    const emptyLabel = host.dataset.empty || "Nothing loaded";

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "dd-trigger";
    const name = document.createElement("span");
    name.className = "dd-name";
    const actions = document.createElement("span");
    actions.className = "dd-actions";
    const dl = glyph("dl", "Download");
    const rm = glyph("rm", "Remove");
    actions.append(dl, rm);
    const caret = document.createElement("span");
    caret.className = "dd-caret";
    caret.textContent = "▾";
    trigger.append(name, actions, caret);

    const menu = document.createElement("div");
    menu.className = "dd-menu";
    host.append(trigger, menu);

    const selectedOption = () => select.options[select.selectedIndex] || null;
    const hasOptions = () => select.options.length > 0;

    function selectIndex(i) {
        if (select.selectedIndex !== i) {
            select.selectedIndex = i;
            select.dispatchEvent(new Event("change", { bubbles: true }));
        }
        refreshTrigger();
    }

    function refreshTrigger() {
        const opt = selectedOption();
        const empty = !(hasOptions() && opt);
        trigger.classList.toggle("dd-empty", empty);
        if (!empty) {
            name.textContent = opt.textContent || opt.value;
            name.classList.remove("placeholder");
            dl.classList.remove("disabled");
            rm.classList.remove("disabled");
        } else {
            name.textContent = emptyLabel;
            name.classList.add("placeholder");
            dl.classList.add("disabled");
            rm.classList.add("disabled");
        }
    }

    function buildMenu() {
        menu.innerHTML = "";
        Array.from(select.options).forEach((opt, i) => {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "dd-item" + (i === select.selectedIndex ? " selected" : "");
            const nm = document.createElement("span");
            nm.className = "dd-name";
            nm.textContent = opt.textContent || opt.value;
            const acts = document.createElement("span");
            acts.className = "dd-actions";
            const idl = glyph("dl", "Download");
            const irm = glyph("rm", "Remove");
            acts.append(idl, irm);
            item.append(nm, acts);

            item.addEventListener("click", () => { selectIndex(i); close(); });
            idl.addEventListener("click", (e) => { e.stopPropagation(); downloadEntry(kind, opt.value); close(); });
            irm.addEventListener("click", (e) => { e.stopPropagation(); removeEntry(kind, opt.value); close(); });
            menu.append(item);
        });

        const add = document.createElement("button");
        add.type = "button";
        add.className = "dd-add";
        const plus = document.createElement("span");
        plus.className = "plus";
        plus.textContent = "+";
        add.append(plus, document.createTextNode(addLabel));
        add.addEventListener("click", () => openPicker(kind));
        menu.append(add);
    }

    function open() {
        closers.forEach((c) => c());
        buildMenu();
        menu.classList.add("open");
        trigger.classList.add("open");
    }
    function close() {
        menu.classList.remove("open");
        trigger.classList.remove("open");
    }
    closers.push(close);

    trigger.addEventListener("click", (e) => {
        e.stopPropagation();
        menu.classList.contains("open") ? close() : open();
    });
    dl.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!dl.classList.contains("disabled")) downloadEntry(kind, select.value);
    });
    rm.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!rm.classList.contains("disabled")) removeEntry(kind, select.value);
    });

    select.addEventListener("change", refreshTrigger);
    new MutationObserver(() => {
        refreshTrigger();
        if (menu.classList.contains("open")) buildMenu();
    }).observe(select, { childList: true });

    refreshTrigger();
}

document.querySelectorAll("[data-dropdown]").forEach(initDropdown);
document.addEventListener("click", () => closers.forEach((c) => c()));

// --- Keys: scrollable list of expandable entries (newest first) -------
const keyContainer = document.getElementById("key-container");
const openHistoryBtn = document.getElementById("openHistory");

function keysEmptyState() {
    keyContainer.innerHTML = '<div class="empty">no keys captured</div>';
}

function renderInto(entry) {
    const empty = keyContainer.querySelector(".empty");
    if (empty) empty.remove();
    if (entry && entry.pssh_data) {
        const existing = keyContainer.querySelector(
            '.key-item[data-pssh="' + CSS.escape(entry.pssh_data) + '"]'
        );
        if (existing) existing.remove();
    }
    keyContainer.prepend(renderKeyEntry(entry, settings));
}

async function loadKeys() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    chrome.storage.local.get(null, (map) => {
        const list = entriesFromMap(map);
        keyContainer.innerHTML = "";

        const tabKeys = tab ? list.filter(e => e.tabId === tab.id) : list;

        if (!tabKeys.length) {
            keysEmptyState();
            return;
        }
        tabKeys.forEach((e) => keyContainer.append(renderKeyEntry(e, settings)));
    });
}

function onStorageChanged(changes, areaName) {
    if (areaName === "local") {
        chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
            for (const [pssh, change] of Object.entries(changes)) {
                if (change.newValue) {
                    if (!tab || change.newValue.tabId === tab.id) {
                        renderInto(change.newValue);
                    }
                } else {
                    const el = keyContainer.querySelector('.key-item[data-pssh="' + CSS.escape(pssh) + '"]');
                    if (el) el.remove();
                }
            }
            if (!keyContainer.querySelector(".key-item")) keysEmptyState();
        });
    } else if (areaName === "sync") {
        for (const [key, change] of Object.entries(changes)) {
            settings[key] = change.newValue;
        }
    }
}

function loadSettings() {
    chrome.storage.sync.get(null, (s) => {
        settings = s || {};
        enabled.checked = !!(settings.enabled ?? true);
        applyEnabled();
        applyTheme(!!settings.dark_mode);
        autoNextToggle.checked = !!settings.auto_next;
        autoNextSelector.value = settings.auto_next_selector || "";
        if (typeof settings.auto_next_skip !== "undefined") {
            document.getElementById("autoNextSkip").value = settings.auto_next_skip;
        }
        applyAutoNext();
        if (settings.device_type === "REMOTE") remoteSelect.checked = true;
        else wvdSelect.checked = true;
        applyDeviceType();
        setServerCert(!!(settings.server_cert ?? false));
        setProxyMode(settings.proxy_mode ?? "event");
        exeName.value = settings.exe_name || "";
        addArgs.value = settings.additional_args || "";
        setPackager(!!settings.use_shaka);
        setQuotes(!!settings.use_single_quotes);
        setSaveName(settings.save_name || "none");
        cmdSection.classList.toggle("collapsed", settings.command_options_collapsed !== false);
        populateSelect(wvdCombo, settings.devices, settings.selected);
        populateSelect(remoteCombo, settings.remote_cdms, settings.selected_remote_cdm);
        booting = false;
        applyCompat();
        loadKeys();
    });
}

if (openHistoryBtn) {
    openHistoryBtn.addEventListener("click", async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const tabParam = tab ? "?tabId=" + tab.id : "";
        const url =
            typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL
                ? chrome.runtime.getURL("ui/history.html" + tabParam)
                : "history.html" + tabParam;
        if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.create) {
            chrome.tabs.create({ url });
        } else {
            window.open(url, "_blank");
        }
        window.close();
    });
}

async function boot() {
    if (typeof chrome !== "undefined" && chrome.storage) {
        chrome.storage.onChanged.addListener(onStorageChanged);
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        loadSettings();
        listenEmeStatus(tab.id);
        refreshEmeStatuses(tab.id);
        checkOutdated(tab.id);
    } else {
        booting = false;
        keysEmptyState();
    }
}

//window.__boot = boot;
boot();
