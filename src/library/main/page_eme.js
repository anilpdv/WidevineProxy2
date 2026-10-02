import { Session } from "./session.js";
import { Util } from "./util.js";

let settings;

const frameId = `[${Math.random().toString(36).slice(2)}]`;

// Spoof Page Visibility API so video players continue loading in background tabs
try {
    Object.defineProperty(Document.prototype, 'visibilityState', { get: () => 'visible', configurable: true });
    Object.defineProperty(Document.prototype, 'hidden', { get: () => false, configurable: true });
} catch (e) {
    try {
        Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
        Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
    } catch (e2) {}
}
try {
    document.hasFocus = () => true;
} catch (e) {}

const blockVisibilityChange = (e) => {
    if (e.type === 'visibilitychange') e.stopImmediatePropagation();
};
window.addEventListener('visibilitychange', blockVisibilityChange, true);
document.addEventListener('visibilitychange', blockVisibilityChange, true);

let settingsPromise = null;
async function getSettings() {
    if (!settings) {
        if (!settingsPromise) {
            settingsPromise = Util.emit("SETTINGS", null);
        }
        settings = await settingsPromise;
    }
    return settings;
}

function getBestTitle() {
    let t = document.title || "";
    try {
        const udemyItem = document.querySelector('[class*="curriculum-item--is-current"] [data-purpose="item-title"]');
        if (udemyItem && udemyItem.textContent && udemyItem.textContent.trim().length > 0) {
            return udemyItem.textContent.trim();
        }
        const udemySection = document.querySelector('section[class*="lecture-view"][aria-label]');
        if (udemySection && udemySection.getAttribute('aria-label')) {
            return udemySection.getAttribute('aria-label');
        }
        const h1 = document.querySelector('h1');
        if (h1 && (h1.innerText || h1.textContent)) {
            const h1Text = (h1.innerText || h1.textContent).trim();
            if (h1Text.length > 0) {
                if (t && t.includes(h1Text)) return t;
                return h1Text + (t ? " - " + t : "");
            }
        }
    } catch (e) {}
    return t;
}

const cdmSessions = new Map();

const mediaKeysServerCertMap = new Map();
const sessionMediaKeysMap = new Map();
const sessionServerCertMap = new Map();

function getWidevineChallengeLocal(licenseRequest, serverCert) {
    const session = new Session({
        deviceType: settings.device.deviceType,
        privateKey: `-----BEGIN RSA PRIVATE KEY-----${settings.device.privateKey}-----END RSA PRIVATE KEY-----`,
        identifierBlob: Util.b64.decode(settings.device.clientId)
    });

    if (serverCert) {
        session.setServiceCertificate(serverCert);
    }

    const result = session.getLicenseChallenge(
        new Uint8Array(licenseRequest),
        settings.server_cert
    );

    if (!result) {
        return licenseRequest;
    }

    cdmSessions.set(result.requestId, session);
    return result.licenseRequest;
}

function parseServerCert(cert) {
    const certBytes = new Uint8Array(cert);

    const signedDrmCert = SignedDrmCertificate.decode(certBytes);
    const drmCert = DrmCertificate.decode(signedDrmCert.drmCertificate);

    const createdDate = new Date(drmCert.creationTimeSeconds * 1000);

    return `Provider ID: ${drmCert.providerId}, Created: ${createdDate.toISOString()}`;
}

async function parseWidevineChallenge(license, mediaKeySession) {
    const licenseBytes = new Uint8Array(license);

    let signedMessage;

    try {
        signedMessage = SignedMessage.decode(licenseBytes);
    } catch (e) {
        return;
    }

    if (signedMessage.type === SignedMessage.MessageType.LICENSE) {
        Util.emit("EME_LICENSE", {
            success: true,
            args: Util.safeStringify([license])
        });

        const licenseObj = License.decode(signedMessage.msg);
        const requestId = Util.b64.encode(licenseObj.id.requestId);

        if (!cdmSessions.has(requestId))
            return;

        const session = cdmSessions.get(requestId);

        let keys;
        let psshData;

        if (session.remote) {
            keys = await Util.emit("REMOTE_PARSE", {
                sessionId: session.sessionId,
                license: Util.b64.encode(licenseBytes)
            });
            psshData = session.psshData;
        } else {
            keys = session.parseLicense(licenseBytes);
            psshData = Util.b64.encode(session.getPsshData());
        }

        console.log("[WVP2]", frameId, "Widevine Keys", keys);

        Util.emit("KEYS", {
            keys: keys,
            pssh_data: psshData,
            timestamp: new Date().getTime(),
            type: "WIDEVINE",
            url: window.location.href,
            title: getBestTitle()
        });

        cdmSessions.delete(requestId);
    } else if (signedMessage.type === SignedMessage.MessageType.SERVICE_CERTIFICATE) {
        const serverCert = new Uint8Array(signedMessage.msg);
        console.log("[WVP2]", frameId, "Server Cert (message):", parseServerCert(serverCert));
        sessionServerCertMap.set(mediaKeySession, serverCert);
    }
}

async function getLicenseChallengeRemote(licenseRequest, serverCert) {
    const messageBytes = new Uint8Array(licenseRequest);

    let signedMessage;
    try {
        signedMessage = SignedMessage.decode(messageBytes);
    } catch (e) {
        return licenseRequest;
    }

    if (signedMessage.type !== SignedMessage.MessageType.LICENSE_REQUEST) {
        throw new Error(`Cannot resign message of type ${signedMessage.type}`);
    }

    const parsedRequest = LicenseRequest.decode(signedMessage.msg);
    const psshData = parsedRequest.contentId.widevinePsshData.psshData[0];

    const sessionId = await Util.emit("REMOTE_OPEN", null);

    if (serverCert) {
        await Util.emit("REMOTE_SET_SERVICE_CERTIFICATE", {
            sessionId: sessionId,
            certificate: Util.b64.encode(serverCert)
        });
    }

    const challengeB64 = await Util.emit("REMOTE_GET_CHALLENGE", {
        sessionId: sessionId,
        initData: Util.b64.encode(psshData),
        privacyMode: settings.server_cert
    });

    if (!challengeB64) {
        return licenseRequest;
    }

    const challenge = Util.b64.decode(challengeB64);

    const newSignedMessage = SignedMessage.decode(challenge);
    const newLicenseRequest = LicenseRequest.decode(newSignedMessage.msg);
    const requestId = Util.b64.encode(newLicenseRequest.contentId.widevinePsshData.requestId);

    cdmSessions.set(requestId, {
        remote: true,
        sessionId: sessionId,
        psshData: Util.b64.encode(psshData)
    });

    return challenge;
}

function parseClearKeyResponse(license) {
    const text = new TextDecoder().decode(new Uint8Array(license));
    const clearKey = JSON.parse(text);

    Util.emit("EME_LICENSE", {
        success: true,
        args: Util.safeStringify([license])
    });

    const decodeKey = (value) => {
        const paddedB64 = value.replace(/-/g, "+").replace(/_/g, "/") + "==";
        const keyBytes = Util.b64.decode(paddedB64);
        return forge.util.bytesToHex(keyBytes);
    }

    const keys = clearKey["keys"].map(key => ({
        ...key,
        kid: decodeKey(key.kid),
        k: decodeKey(key.k)
    }));

    const psshData =  btoa(JSON.stringify({
        kids: clearKey["keys"].map(key => key.kid)
    }));

    Util.emit("KEYS", {
        keys: keys,
        pssh_data: psshData,
        timestamp: new Date().getTime(),
        type: "CLEARKEY",
        url: window.location.href,
        title: getBestTitle()
    });
}

if (typeof MediaKeySystemAccess !== "undefined") {
    Util.proxy(MediaKeySystemAccess.prototype, "createMediaKeys", (_target, _this, _args) => {
        return Util.logEme("EME_CREATE_MEDIA_KEYS", _args, async () => {
            return await _target.apply(_this, _args);
        });
    });
}

if (typeof MediaKeys !== "undefined") {
    Util.proxy(MediaKeys.prototype, "setServerCertificate", async (_target, _this, _args) => {
        console.log("[WVP2]", frameId, "Server Cert (setServerCertificate):", parseServerCert(_args[0]));
        const result = await _target.apply(_this, _args);
        mediaKeysServerCertMap.set(_this, new Uint8Array(_args[0]));
        return result;
    });

    Util.proxy(MediaKeys.prototype, "createSession", (_target, _this, _args) => {
        return Util.logEme("EME_CREATE_SESSION", _args, () => {
            const result = _target.apply(_this, _args);
            sessionMediaKeysMap.set(result, _this);
            return result;
        });
    });
}

if (typeof MediaKeySession !== "undefined") {
    Util.proxy(MediaKeySession.prototype, "generateRequest", (_target, _this, _args) => {
        return Util.logEme("EME_GENERATE_REQUEST", _args, async () => {
            return await _target.apply(_this, _args);
        });
    });

    if (typeof MediaKeyMessageEvent !== "undefined") {
        const getServerCert = (_this) => {
            const mediaKeys = sessionMediaKeysMap.get(_this);
            if (mediaKeys) {
                const serverCert = mediaKeysServerCertMap.get(mediaKeys);
                if (serverCert) {
                    return serverCert;
                }
            }
            return sessionServerCertMap.get(_this);
        }

        const resignChallenge = async (message, serverCert) => {
            const currentSettings = await getSettings();
            if (!currentSettings) return message;

            try {
                // If we don't fail to parse the message as JSON it's ClearKey and we don't continue
                const text = new TextDecoder().decode(message);
                JSON.parse(text);
                return;
            } catch (e) {
                // ignored
            }

            if (currentSettings.device_type === "WVD") {
                return getWidevineChallengeLocal(message, serverCert);
            } else if (currentSettings.device_type === "REMOTE") {
                return await getLicenseChallengeRemote(message, serverCert);
            }
            return message;
        };

        const interceptChallenge = async (_args, _this, _thisTarget, type) => {
            const [e] = _args;

            if (!(e instanceof MediaKeyMessageEvent) || !e.isTrusted || e.message.byteLength <= 2) {
                return;
            }

            Util.emit("EME_LICENSE_REQUEST", {
                success: true,
                args: Util.safeStringify(e.message)
            });

            const currentSettings = await getSettings();
            const proxyMode = currentSettings?.proxy_mode ?? "event";

            const serverCert = getServerCert(type === "object" ? _thisTarget : _this);
            const newChallenge = await resignChallenge(e.message, serverCert);

            if (!newChallenge) {
                return;
            }

            console.log("[WVP2]", "New challenge:", Util.b64.encode(newChallenge));
            console.log("[WVP2]", frameId, `Intercepted (${proxyMode}/${type})`, _args[0]);

            if (proxyMode === "property") {
                Object.defineProperty(e, "message", {
                    configurable: true,
                    get: () => new Uint8Array(newChallenge).buffer
                });
            } else if (proxyMode === "event") {
                const clonedEvent = new MediaKeyMessageEvent("message", {
                    messageType: e.messageType,
                    message: new Uint8Array(newChallenge).buffer
                });

                e.stopImmediatePropagation();
                e.preventDefault();

                _thisTarget.dispatchEvent(clonedEvent);
                return true;
                // true = we stop here because the dispatched event above will trigger the handler on its own
            }
        }

        const wrapListener = (listener, _thisTarget) => {
            if (typeof listener === "function") {
                return new Proxy(listener, {
                    async apply(_target, _this, _args) {
                        if (!(await interceptChallenge(_args, _this, _thisTarget, "function")))
                            return Reflect.apply(_target, _this, _args);
                    }
                });
            } else if (typeof listener === "object" && typeof listener.handleEvent === "function") {
                Util.proxy(listener, "handleEvent", async (_target, _this, _args) => {
                    if (!(await interceptChallenge(_args, _this, _thisTarget, "object")))
                        return Reflect.apply(_target, _this, _args);
                });
            }
            return listener;
        }

        Util.proxy(MediaKeySession.prototype, "addEventListener", (_target, _this, _args) => {
            const [type, listener] = _args;

            if (_this == null || type !== "message") {
                return _target.apply(_this, _args);
            }

            _args[1] = wrapListener(listener, _this);

            return _target.apply(_this, _args);
        });
    }

    Util.proxy(MediaKeySession.prototype, "update", (_target, _this, _args) => {
        if (_this == null || !(_this instanceof MediaKeySession)) {
            return _target.apply(_this, _args);
        }

        try {
            parseClearKeyResponse(_args[0]);
        } catch (e) {
            parseWidevineChallenge(_args[0], _this);
        }

        try {
            return _target.apply(_this, _args);
        } catch (e) {
            // ignored, since this will always fail
        }
    });
}

(async () => {
    settings = await Util.emit("SETTINGS", null);
})();