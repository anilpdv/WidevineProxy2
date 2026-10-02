import { ICON_TRASH } from "./icons.js";

function copyToClipboard(btn, text) {
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
    const prev = btn.textContent;
    btn.classList.add("copied");
    btn.textContent = "copied";
    setTimeout(() => { btn.classList.remove("copied"); btn.textContent = prev; }, 1200);
}

export function normalizeType(type) {
    const t = (type || "").toLowerCase();
    if (t.includes("dash") || t.includes("mpd")) return "DASH";
    if (t.includes("hls") || t.includes("m3u8")) return "HLS";
    if (t.includes("mss") || t.includes("smooth") || t.includes("ism")) return "MSS";
    return "OTHER";
}

export function manifests(entry) {
    return (entry && entry.manifests) || [];
}

export function keyLines(entry) {
    return ((entry && entry.keys) || []).map((k) =>
        typeof k === "string" ? k : k.kid + ":" + k.k
    );
}

function shellQuote(value, single) {
    const s = String(value == null ? "" : value);
    return single
        ? "'" + s.replace(/'/g, "'\\''") + "'"
        : '"' + s.replace(/"/g, '\\"') + '"';
}

function sanitizeName(s) {
    let name = String(s == null ? "" : s)
        .normalize("NFC")
        .replace(/[\u0000-\u001f\u007f]+/g, "")   // strip control chars
        .replace(/[<>:"/\\|?*]+/g, "")            // filesystem-reserved chars
        .replace(/\s+/g, " ")                     // collapse whitespace
        .replace(/_{2,}/g, "_")                   // collapse underscores
        .replace(/^[\s._]+|[\s._]+$/g, "")        // trim junk from the ends
        .slice(0, 120)                                                 // keep it a sane length
        .replace(/[\s._]+$/g, "");                // re-trim after the slice
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name))
        name = "_" + name;
    return name;
}

function slugFromUrl(u) {
    try {
        const parsed = new URL(u);
        let base = parsed.pathname.split("/").filter(Boolean).pop() || parsed.hostname;
        base = sanitizeName(decodeURIComponent(base.replace(/\.[a-z0-9]+$/i, "")));
        return base || sanitizeName(parsed.hostname);
    } catch (e) {
        return "";
    }
}

function saveName(mode, entry) {
    if (mode === "url")
        return slugFromUrl(entry.url);
    if (mode === "title")
        return entry.title ? sanitizeName(entry.title) : slugFromUrl(entry.url);

    return "";
}

export function buildCommand(entry, settings, manifestIndex) {
    settings = settings || {};
    entry = entry || {};
    const exe = settings.exe_name || "N_m3u8DL-RE";
    const single = !!settings.use_single_quotes; // bash prefers single quotes
    const q = (s) => shellQuote(s, single);
    const mans = manifests(entry);
    const manifest = mans[manifestIndex || 0] || mans[0] || {};
    const url = manifest.url || "";

    const parts = [exe];
    if (url)
        parts.push(q(url));

    const name = saveName(settings.save_name, entry);
    if (name)
        parts.push("--save-name " + q(name));

    const headers = manifest.headers || {};
    Object.keys(headers).forEach((h) => {
        parts.push("-H " + q(h + ": " + headers[h]));
    });

    keyLines(entry).forEach((kv) => parts.push("--key " + kv));

    if (settings.use_shaka)
        parts.push("--use-shaka-packager");

    if (settings.additional_args)
        parts.push(settings.additional_args);
    else
        parts.push("-M format=mkv");

    return parts.join(" ");
}

function kvRow(label, valueNode, copyText) {
    const row = document.createElement("div");
    row.className = "kv-row";
    const l = document.createElement("span");
    l.className = "kv-label";
    l.textContent = label;
    row.append(l, valueNode);
    if (copyText) {
        const c = document.createElement("button");
        c.type = "button";
        c.className = "kv-copy";
        c.textContent = "copy";
        c.addEventListener("click", (e) => {
            e.stopPropagation();
            copyToClipboard(c, typeof copyText === "function" ? copyText() : copyText);
        });
        row.append(c);
    }
    return row;
}

function inputVal(str) {
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = "kv-input";
    inp.readOnly = true;
    inp.value = str || "-";
    return inp;
}

function fmtTime(ts) {
    if (!ts) return "";
    const ms = ts < 1e12 ? ts * 1000 : ts; // stored in unix seconds
    const d = new Date(ms);
    if (isNaN(d)) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return (
        d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
        " " + pad(d.getHours()) + ":" + pad(d.getMinutes())
    );
}

export function renderKeyEntry(entry, settings, onDelete) {
    entry = entry || {};
    const item = document.createElement("div");
    item.className = "key-item";
    if (entry.pssh_data) item.dataset.pssh = entry.pssh_data;

    // shows the page URL the entry was captured on
    const head = document.createElement("div");
    head.className = "key-head";
    head.setAttribute("role", "button");
    head.tabIndex = 0;
    const caret = document.createElement("span");
    caret.className = "key-caret";
    caret.textContent = "▸";
    // page Title or URL
    const titleText = document.createElement("span");
    titleText.className = "key-url"; // keep same class for styling
    titleText.textContent = entry.title || entry.url || "(unknown page)";
    titleText.title = entry.url || "";
    head.append(caret, titleText);

    if (entry.type) {
        const typePill = document.createElement("span");
        typePill.className = "key-type " + String(entry.type).toLowerCase();
        typePill.textContent = String(entry.type).toUpperCase();
        if (entry.timestamp) typePill.title = fmtTime(entry.timestamp);
        head.append(typePill);
    }

    const lines = keyLines(entry);
    if (lines.length) {
        const chip = document.createElement("span");
        chip.className = "key-chip";
        chip.textContent = lines.length + " key" + (lines.length > 1 ? "s" : "");
        head.append(chip);
    }

    if (typeof onDelete === "function") {
        const del = document.createElement("span");
        del.className = "key-del";
        del.title = "Delete entry";
        del.innerHTML = ICON_TRASH;
        del.addEventListener("click", (e) => {
            e.stopPropagation();
            onDelete(entry.pssh_data, item);
        });
        head.append(del);
    }

    const body = document.createElement("div");
    body.className = "key-body";

    body.append(kvRow("PSSH", inputVal(entry.pssh_data), entry.pssh_data));

    if (lines.length) {
        const keySel = document.createElement("select");
        keySel.className = "kv-select";
        lines.forEach((line, i) => {
            const o = document.createElement("option");
            o.value = String(i);
            o.textContent = line;
            keySel.append(o);
        });
        keySel.addEventListener("click", (e) => e.stopPropagation());
        body.append(kvRow("Keys", keySel, () => lines.map((line) => "--key " + line).join(" ")));
    } else {
        body.append(kvRow("Keys", inputVal(""), ""));
    }

    const mans = manifests(entry);
    if (mans.length) {
        const sel = document.createElement("select");
        sel.className = "kv-select";
        mans.forEach((m, i) => {
            const o = document.createElement("option");
            o.value = String(i);
            o.textContent = normalizeType(m.type) + " · " + (m.url || "");
            sel.append(o);
        });
        body.append(kvRow("Manifest", sel, () => mans[Number(sel.value)].url || ""));

        const cmdInput = inputVal(buildCommand(entry, settings, 0));
        body.append(kvRow("Command", cmdInput, () => cmdInput.value));

        // Re-write the command whenever the manifest OR settings change.
        item.refreshCmd = () => {
            cmdInput.value = buildCommand(entry, settings, Number(sel.value));
        };
        sel.addEventListener("click", (e) => e.stopPropagation());
        sel.addEventListener("change", item.refreshCmd);
    }

    item.append(head, body);
    head.addEventListener("click", () => item.classList.toggle("open"));
    head.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); item.classList.toggle("open"); }
    });
    return item;
}

export function entriesFromMap(map) {
    return Object.values(map || {}).sort(
        (a, b) => (b.timestamp || 0) - (a.timestamp || 0)
    );
}

export function searchText(entry) {
    entry = entry || {};
    const parts = [entry.url, entry.pssh_data, entry.type];
    manifests(entry).forEach((m) => {
        parts.push(m.url, m.type);
    });
    return parts.concat(keyLines(entry)).filter(Boolean).join(" ").toLowerCase();
}

export function refreshCommands(root) {
    (root || document).querySelectorAll(".key-item").forEach((el) => {
        if (typeof el.refreshCmd === "function") el.refreshCmd();
    });
}
