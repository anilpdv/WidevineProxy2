import { Util } from "./util.js";

const handlers = new Map();
const manifestUrls = new Map();
const manifestHeaders = new Map();
const emeStatuses = {};

function onMessage(type, handler) {
    handlers.set(type, handler);
}

function relayToBackground(type) {
    onMessage(type, async (payload) => {
        const response = await chrome.runtime.sendMessage({ type, payload });
        if (response && response.error)
            throw new Error(response.error);
        return response ? response.data : undefined;
    });
}

relayToBackground("REMOTE_OPEN");
relayToBackground("REMOTE_SET_SERVICE_CERTIFICATE");
relayToBackground("REMOTE_GET_CHALLENGE");
relayToBackground("REMOTE_PARSE");

onMessage("SETTINGS", async _ => {
    const settings = await chrome.storage.sync.get(["selected", "selected_remote_cdm", "server_cert", "proxy_mode", "device_type"]);

    if (!settings)
        return;

    const deviceType = settings.device_type ?? "WVD";

    let device;

    if (deviceType === "WVD") {
        const deviceObj = await chrome.storage.sync.get([settings.selected]);
        device = Util.readWidevineDevice(deviceObj[settings.selected]);
    } else if (deviceType === "REMOTE") {
        const deviceObj = await chrome.storage.sync.get([settings.selected_remote_cdm]);
        device = deviceObj[settings.selected_remote_cdm];
    }

    return {
        device: device,
        device_type: deviceType,
        server_cert: settings.server_cert ?? false,
        proxy_mode: settings.proxy_mode ?? "event"
    }
});

onMessage("MANIFEST_URL", async (data) => {
    const { url, tab_url } = data;
    delete data.tab_url;

    if (!manifestUrls.has(tab_url)) {
        manifestUrls.set(tab_url, [data]);
    } else {
        let elements = manifestUrls.get(tab_url);
        if (!elements.some(e => e.url === url)) {
            elements.push(data);
            manifestUrls.set(tab_url, elements);
        }
    }
})

// Auto-Navigation & Auto-Skip logic
let currentAutoUrl = window.location.href;
let skipTimer = null;
let autoNextClickedForUrl = false;
let isVideoDetected = false;
let isEmeDetected = false;
let videoObserver = null;
let videoCheckInterval = null;

function doClickNext(selector, reason) {
    if (!selector) return false;
    const element = document.querySelector(selector);
    if (element) {
        if (element.disabled || element.getAttribute('aria-disabled') === 'true') {
            return false;
        }
        console.log(`WidevineProxy2: Auto-next clicking selector (${reason})`, selector);
        const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
        events.forEach(type => {
            element.dispatchEvent(new MouseEvent(type, {
                view: window,
                bubbles: true,
                cancelable: true,
                buttons: 1
            }));
        });
        try {
            element.click();
        } catch (e) {}
        return true;
    }
    return false;
}

function tryPlayVideo(video) {
    if (!video || video.ended) return;
    if (video.paused) {
        const p = video.play();
        if (p !== undefined) {
            p.catch(() => {
                // If browser blocks unmuted autoplay in background, mute and retry
                video.muted = true;
                video.play().catch(() => {});
            });
        }
    }
}

function markVideoDetected(video) {
    isVideoDetected = true;
    if (skipTimer) {
        clearTimeout(skipTimer);
        skipTimer = null;
    }
    if (video) {
        tryPlayVideo(video);
    }
}

async function initAutoNavigation() {
    if (window !== window.top) return;

    if (skipTimer) {
        clearTimeout(skipTimer);
        skipTimer = null;
    }
    if (videoObserver) {
        videoObserver.disconnect();
        videoObserver = null;
    }
    if (videoCheckInterval) {
        clearInterval(videoCheckInterval);
        videoCheckInterval = null;
    }

    autoNextClickedForUrl = false;
    isVideoDetected = false;
    isEmeDetected = false;

    const settings = await chrome.storage.sync.get(["auto_next", "auto_next_selector", "auto_next_skip"]);
    if (!settings || !settings.auto_next || !settings.auto_next_selector) {
        return;
    }

    // 1. Check if video element already exists on the page
    const existingVideo = document.querySelector("video");
    if (existingVideo) {
        markVideoDetected(existingVideo);
        return;
    }

    // 2. Observe DOM for video element mounting (common in single-page apps like Udemy)
    videoObserver = new MutationObserver(() => {
        const vid = document.querySelector("video");
        if (vid) {
            markVideoDetected(vid);
            if (videoObserver) {
                videoObserver.disconnect();
                videoObserver = null;
            }
        }
    });
    videoObserver.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true
    });

    // 3. Short periodic check for video in the first few seconds
    let pollCount = 0;
    videoCheckInterval = setInterval(() => {
        const vid = document.querySelector("video");
        if (vid) {
            markVideoDetected(vid);
            clearInterval(videoCheckInterval);
            videoCheckInterval = null;
        } else if (++pollCount > 10) {
            clearInterval(videoCheckInterval);
            videoCheckInterval = null;
        }
    }, 500);

    // 4. Non-video auto-skip timeout
    const skipSeconds = Math.max(0, parseInt(settings.auto_next_skip, 10) || 0);
    if (skipSeconds > 0) {
        // If URL explicitly indicates a quiz/practice test, wait skipSeconds.
        // If it's a lecture/video page, wait at least 4s grace period before concluding no video exists.
        const isExplicitNonVideo = /\/(quiz|practice|exercise)\//i.test(window.location.href);
        const waitMs = isExplicitNonVideo ? (skipSeconds * 1000) : (Math.max(skipSeconds, 4) * 1000);

        skipTimer = setTimeout(() => {
            const vid = document.querySelector("video");
            if (vid || isVideoDetected || isEmeDetected) {
                if (vid) markVideoDetected(vid);
                return;
            }

            if (currentAutoUrl === window.location.href && !autoNextClickedForUrl) {
                console.log(`WidevineProxy2: Auto-skip triggered after non-video timeout (${waitMs}ms) for`, currentAutoUrl);

                let attempts = 0;
                const tryClick = setInterval(() => {
                    if (currentAutoUrl !== window.location.href || autoNextClickedForUrl) {
                        clearInterval(tryClick);
                        return;
                    }
                    if (doClickNext(settings.auto_next_selector, "non-video skip timeout")) {
                        autoNextClickedForUrl = true;
                        clearInterval(tryClick);
                    } else if (++attempts > 20) {
                        clearInterval(tryClick);
                        console.log("WidevineProxy2: Auto-skip element not found after retries", settings.auto_next_selector);
                    }
                }, 500);
            }
        }, waitMs);
    }
}

if (window === window.top) {
    initAutoNavigation();

    setInterval(() => {
        if (window.location.href !== currentAutoUrl) {
            currentAutoUrl = window.location.href;
            initAutoNavigation();
        }
    }, 500);

    window.addEventListener("popstate", () => {
        if (window.location.href !== currentAutoUrl) {
            currentAutoUrl = window.location.href;
            initAutoNavigation();
        }
    });
}

onMessage("KEYS", async (data) => {
    try {
        if (manifestUrls.has(data.url)) {
            const urls = manifestUrls.get(data.url);
            urls.forEach(e => {
                if (manifestHeaders.has(e.url)) {
                    e.headers = manifestHeaders.get(e.url);
                }
            })
            if (!!urls)
                data.manifests = urls;
        }
    } catch (e) {
        console.error("KEY handler failed", e);
        throw e;
    }

    try {
        const tabRes = await chrome.runtime.sendMessage({ type: "GET_TAB_ID" });
        if (tabRes && tabRes.data) {
            data.tabId = tabRes.data;
        }
    } catch(e) {}

    await chrome.storage.local.set({ [data.pssh_data]: data });

    if (window === window.top) {
        const settings = await chrome.storage.sync.get(["auto_next", "auto_next_selector"]);
        if (settings && settings.auto_next && settings.auto_next_selector) {
            autoNextClickedForUrl = true;
            if (skipTimer) {
                clearTimeout(skipTimer);
                skipTimer = null;
            }

            let attempts = 0;
            const tryClick = setInterval(() => {
                if (doClickNext(settings.auto_next_selector, "keys fetched")) {
                    clearInterval(tryClick);
                } else if (++attempts > 20) {
                    clearInterval(tryClick);
                    console.log("WidevineProxy2: Auto-next element not found after 10 seconds", settings.auto_next_selector);
                }
            }, 500);
        }
    }
});

function onEmeStatusMessage(type) {
    onMessage(type, (data) => {
        emeStatuses[type] = data;
        isEmeDetected = true;
        if (skipTimer) {
            clearTimeout(skipTimer);
            skipTimer = null;
        }
        chrome.runtime.sendMessage({
            type: "EME_STATUS_REACTIVE",
            payload: {
                type: type,
                data: data
            }
        });
    });
}

onEmeStatusMessage("EME_CREATE_MEDIA_KEYS");
onEmeStatusMessage("EME_CREATE_SESSION");
onEmeStatusMessage("EME_GENERATE_REQUEST");
onEmeStatusMessage("EME_LICENSE_REQUEST");
onEmeStatusMessage("EME_LICENSE");

document.addEventListener('__ext_response', async (event) => {
    const detail = structuredClone(event.detail); // I don't know, this is needed in Firefox on Android
    const { type, body, requestId } = detail;

    const handler = handlers.get(type);

    let responseBody = null;
    let error = null;

    if (!handler) {
        error = `No handler registered for type "${type}"`;
    } else {
        try {
            responseBody = await handler(body);
        } catch (err) {
            error = err?.message || String(err);
        }
    }

    function dispatchToPage(eventName, detail) {
        if (typeof cloneInto === 'function') {
            const win = window.wrappedJSObject;
            const clonedDetail = cloneInto(detail, win);
            const ev = new win.CustomEvent(eventName, cloneInto({ detail: clonedDetail }, win));
            document.dispatchEvent(ev);
        } else {
            document.dispatchEvent(new CustomEvent(eventName, { detail }));
        }
    }

    dispatchToPage('__ext_responseReceived', {
        requestId,
        body: responseBody,
        error,
    });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "MANIFEST_HEADERS") {
        const { url, headers } = message.payload;
        manifestHeaders.set(url, headers);
    } else if (message.type === "EME_STATUS_ACTIVE") {
        if (Object.keys(emeStatuses).length > 0) {
            sendResponse(emeStatuses);
        }
    } else if (message.type === "START_PICKER") {
        if (window === window.top) {
            startPicker();
        }
    }
});

function getCssSelector(el) {
    let path = [];
    while (el && el.nodeType === Node.ELEMENT_NODE) {
        let selector = el.tagName.toLowerCase();
        if (el.id) {
            selector += '#' + CSS.escape(el.id);
            path.unshift(selector);
            break;
        } else if (typeof el.className === 'string' && el.className.trim()) {
            selector += el.className.trim().split(/\s+/).map(c => '.' + CSS.escape(c)).join('');
            path.unshift(selector);
        } else {
            let sib = el, nth = 1;
            while (sib = sib.previousElementSibling) {
                if (sib.tagName.toLowerCase() == selector) nth++;
            }
            if (nth != 1) selector += ":nth-of-type("+nth+")";
            path.unshift(selector);
        }
        el = el.parentNode;
    }
    return path.join(' > ');
}

let pickerActive = false;
function startPicker() {
    if (pickerActive) return;
    pickerActive = true;

    const overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.top = "0";
    overlay.style.left = "0";
    overlay.style.width = "100%";
    overlay.style.height = "100%";
    overlay.style.zIndex = "999999";
    overlay.style.cursor = "crosshair";
    overlay.style.background = "rgba(0,0,0,0.1)";
    document.body.appendChild(overlay);

    let lastTarget = null;
    let originalOutline = "";

    const onMouseMove = (e) => {
        overlay.style.pointerEvents = "none";
        const target = document.elementFromPoint(e.clientX, e.clientY);
        overlay.style.pointerEvents = "auto";

        if (target && target !== lastTarget && target !== overlay) {
            if (lastTarget) {
                lastTarget.style.outline = originalOutline;
            }
            lastTarget = target;
            originalOutline = target.style.outline;
            target.style.outline = "3px solid #d11124";
        }
    };

    const onClick = async (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (lastTarget) {
            lastTarget.style.outline = originalOutline;
            const selector = getCssSelector(lastTarget);
            await chrome.storage.sync.set({ auto_next_selector: selector });
            alert("WidevineProxy2: Auto-next selector saved as \\n" + selector);
        }

        cleanup();
    };

    const onKeyDown = (e) => {
        if (e.key === "Escape") {
            cleanup();
        }
    };

    const cleanup = () => {
        pickerActive = false;
        if (lastTarget) {
            lastTarget.style.outline = originalOutline;
        }
        overlay.remove();
        document.removeEventListener("mousemove", onMouseMove, true);
        overlay.removeEventListener("click", onClick, true);
        document.removeEventListener("keydown", onKeyDown, true);
    };

    document.addEventListener("mousemove", onMouseMove, true);
    overlay.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
}
