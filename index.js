// wa-gateway-v2: unofficial multi-session WhatsApp gateway, on Baileys.
//
// Same HTTP API as wa-gateway v1, so an app pointed at this port needs no code
// change - only WhatsappConfig.gateway_url moves from :3001 to :3002.
//
// The difference is underneath: v1 drove a real Chromium per sender (300-800MB
// each, and every browser crash or page reload broke sending). This speaks the
// multi-device protocol over a WebSocket - no browser, ~30-50MB per sender.
//
// WARNING: still unofficial. Violates WhatsApp ToS. Sender numbers can get
// banned. Keep volume low and the pacing conservative.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const qrcode = require('qrcode');
const pino = require('pino');
const { NodeCache } = require('@cacheable/node-cache');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
    DisconnectReason,
    Browsers,
} = require('baileys');

const PORT = process.env.PORT || 3002;
const API_KEY = process.env.API_KEY || 'change-this-shared-secret'; // master key: unrestricted, any session_id
const AUTH_DIR = path.join(__dirname, '.baileys_auth');

const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'silent' });

// Per-client scoped keys, e.g. in .env:
//   SCOPED_API_KEYS=naweb:naweb-secret-key,gweb:gweb-secret-key
// A request authenticated with a scoped key may only touch sessions whose id
// starts with "<prefix>-". Lets many clients share one gateway without one
// leaked key exposing every other client's sessions.
const SCOPED_API_KEYS = new Map(); // key -> prefix

// Keys minted by POST /provision live here, NOT in .env, so code never
// rewrites a file you maintain by hand.
const PROVISIONED_FILE = path.join(__dirname, 'provisioned-keys.json');

function readProvisionedKeys() {
    try {
        const obj = JSON.parse(fs.readFileSync(PROVISIONED_FILE, 'utf8'));
        return obj && typeof obj === 'object' ? obj : {};
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.error('[provision] could not read provisioned-keys.json:', err.message);
        }
        return {};
    }
}

function writeProvisionedKeys(map) {
    // Write-then-rename: a crash mid-write must not leave a truncated file that
    // would silently drop every provisioned client on the next reload.
    const tmp = PROVISIONED_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, PROVISIONED_FILE);
}

function loadScopedApiKeys() {
    let raw = process.env.SCOPED_API_KEYS || '';

    // Read the file directly - dotenv populates process.env once, so on a
    // reload the file is the source of truth.
    try {
        const envText = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
        const line = envText.split(/\r?\n/).find((l) => l.trim().startsWith('SCOPED_API_KEYS='));
        if (line) raw = line.slice(line.indexOf('=') + 1).trim();
    } catch (err) { /* no .env - fall back to the environment */ }

    const next = new Map();
    raw.split(',').forEach((entry) => {
        const trimmed = entry.trim();
        if (!trimmed) return;
        const sep = trimmed.indexOf(':');
        if (sep === -1) {
            console.warn(`[config] ignoring malformed SCOPED_API_KEYS entry: "${trimmed}" (expected prefix:key)`);
            return;
        }
        const prefix = trimmed.slice(0, sep).trim();
        const key = trimmed.slice(sep + 1).trim();
        if (!prefix || !key) return;
        next.set(key, prefix);
    });

    const provisioned = readProvisionedKeys();
    Object.keys(provisioned).forEach((prefix) => {
        const key = String(provisioned[prefix] || '').trim();
        if (prefix && key) next.set(key, prefix);
    });

    SCOPED_API_KEYS.clear();
    next.forEach((prefix, key) => SCOPED_API_KEYS.set(key, prefix));
    const envCount = SCOPED_API_KEYS.size - Object.keys(provisioned).length;
    console.log(`[config] loaded ${SCOPED_API_KEYS.size} scoped API key(s) `
        + `(${Math.max(0, envCount)} from .env, ${Object.keys(provisioned).length} provisioned): `
        + `${[...SCOPED_API_KEYS.values()].join(', ')}`);
}

function keyForPrefix(prefix) {
    for (const [key, pfx] of SCOPED_API_KEYS.entries()) {
        if (pfx === prefix) return key;
    }
    return null;
}

loadScopedApiKeys();

try {
    let pending = null;
    fs.watch(path.join(__dirname, '.env'), () => {
        clearTimeout(pending);
        pending = setTimeout(() => {
            console.log('[config] .env changed - reloading scoped API keys');
            loadScopedApiKeys();
        }, 500);
    });
} catch (err) {
    console.warn('[config] could not watch .env (edit + SIGHUP still works):', err.message);
}

try {
    let pending = null;
    fs.watch(__dirname, (evt, filename) => {
        if (filename !== 'provisioned-keys.json') return;
        clearTimeout(pending);
        pending = setTimeout(() => {
            console.log('[config] provisioned-keys.json changed - reloading');
            loadScopedApiKeys();
        }, 500);
    });
} catch (err) {
    console.warn('[config] could not watch provisioned-keys.json:', err.message);
}

process.on('SIGHUP', () => {
    console.log('[config] SIGHUP - reloading scoped API keys');
    loadScopedApiKeys();
});

// One session's error must never take the process down with every other
// sender's connection.
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

const app = express();
app.use(express.json({ limit: '20mb' })); // PDF attachments arrive as base64
app.use((req, res, next) => {
    console.log(`[http] ${req.method} ${req.path}`);
    next();
});

// sessionId -> { sock, status: 'starting'|'qr'|'connected'|'disconnected', qr, number, needsQr }
const sessions = new Map();

// Sessions that need a human to scan; the watchdog leaves them alone.
const noAutoStart = new Set();

// ---------------------------------------------------------------------------
// Self-service provisioning
//
// A client's app asks its OWN gateway (same machine) for a scoped key. Loopback
// IS the authentication, checked on the socket and never from a header:
// X-Forwarded-For is attacker-controlled.
// ---------------------------------------------------------------------------
function isLoopback(req) {
    const addr = (req.socket && req.socket.remoteAddress) || '';
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

app.post('/provision', (req, res) => {
    if (!isLoopback(req)) {
        console.warn(`[provision] REFUSED non-loopback request from ${req.socket && req.socket.remoteAddress}`);
        return res.status(403).json({ ok: false, error: 'provisioning is only allowed from this machine' });
    }

    const prefix = String((req.body && req.body.prefix) || '').trim();
    const existingKey = String((req.body && req.body.existing_key) || '').trim();

    if (!/^[a-z0-9][a-z0-9-]{2,80}$/i.test(prefix)) {
        return res.status(400).json({ ok: false, error: 'invalid prefix' });
    }

    const current = keyForPrefix(prefix);
    if (current) {
        if (existingKey && existingKey === current) {
            return res.json({ ok: true, prefix, api_key: current, created: false });
        }
        return res.status(409).json({
            ok: false,
            error: 'this prefix is already provisioned; send its current key as existing_key to retrieve it',
        });
    }

    const key = require('crypto').randomBytes(32).toString('hex');
    const map = readProvisionedKeys();
    map[prefix] = key;
    try {
        writeProvisionedKeys(map);
    } catch (err) {
        console.error('[provision] could not persist key:', err.message);
        return res.status(500).json({ ok: false, error: 'could not persist the key' });
    }
    loadScopedApiKeys();
    console.log(`[provision] minted a key for "${prefix}"`);   // never log the key itself
    return res.json({ ok: true, prefix, api_key: key, created: true });
});

function requireApiKey(req, res, next) {
    const key = req.get('X-API-KEY');
    if (key === API_KEY) {
        req.sessionPrefix = null; // master key: no restriction
        return next();
    }
    if (SCOPED_API_KEYS.has(key)) {
        req.sessionPrefix = SCOPED_API_KEYS.get(key);
        return next();
    }
    return res.status(401).json({ ok: false, error: 'unauthorized' });
}

function requireSessionAccess(req, res, next) {
    if (req.sessionPrefix === null) return next(); // master key
    const sessionId = req.params.id || (req.body && req.body.session);
    if (sessionId && sessionId.startsWith(`${req.sessionPrefix}-`)) return next();
    return res.status(403).json({
        ok: false,
        error: `this API key may only access sessions starting with "${req.sessionPrefix}-"`,
    });
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
function sessionDir(sessionId) {
    return path.join(AUTH_DIR, `session-${sessionId}`);
}

function hasSavedLogin(sessionId) {
    return fs.existsSync(path.join(sessionDir(sessionId), 'creds.json'));
}

function savedSessionIds() {
    try {
        return fs.readdirSync(AUTH_DIR, { withFileTypes: true })
            .filter((e) => e.isDirectory() && e.name.startsWith('session-'))
            .map((e) => e.name.slice('session-'.length))
            .filter(hasSavedLogin);
    } catch (err) {
        return [];
    }
}

async function destroySession(sessionId) {
    const s = sessions.get(sessionId);
    sessions.delete(sessionId);
    if (s && s.sock) {
        try {
            s.sock.ev.removeAllListeners();
            s.sock.end();
        } catch (err) {
            console.warn(`[${sessionId}] end() failed (ignored):`, err.message);
        }
    }
}

// Cached once: fetchLatestBaileysVersion does a network call, and a session
// must still start when that call fails.
let waVersion = null;
async function whatsappVersion() {
    if (waVersion) return waVersion;
    try {
        const { version } = await fetchLatestBaileysVersion();
        waVersion = version;
        console.log(`[config] WhatsApp Web version ${version.join('.')}`);
    } catch (err) {
        console.warn('[config] could not fetch the WhatsApp version, using the bundled default:', err.message);
        waVersion = undefined;
    }
    return waVersion;
}

// What was sent, kept for a day so a retry request can be answered.
const sentMessages = new NodeCache({ stdTTL: 24 * 60 * 60, useClones: false, maxKeys: 20000 });
const msgRetryCounterCache = new NodeCache({ stdTTL: 60 * 60, useClones: false });

function rememberSent(sessionId, sent) {
    if (!sent || !sent.key || !sent.key.id || !sent.message) return;
    try {
        sentMessages.set(`${sessionId}:${sent.key.id}`, sent.message);
    } catch (err) {
        console.warn(`[${sessionId}] could not keep message for retries:`, err.message);
    }
}

async function startSession(sessionId, startedByHuman) {
    const existing = sessions.get(sessionId);
    if (existing && existing.status !== 'disconnected') return existing;
    if (existing) await destroySession(sessionId);

    const s = {
        sock: null,
        status: 'starting',
        qr: null,
        number: null,
        needsQr: false,
        startedByHuman: !!startedByHuman,
    };
    sessions.set(sessionId, s);

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir(sessionId));
    const version = await whatsappVersion();

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        logger,
        // A recipient that cannot decrypt a message asks for it again. Without
        // these two it stays on "Waiting for this message" on their phone.
        msgRetryCounterCache,
        getMessage: async (key) => sentMessages.get(`${sessionId}:${key.id}`),
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        // We only ever send. Pulling chat history and broadcasting presence
        // costs memory and bandwidth for data nothing here reads.
        syncFullHistory: false,
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
    });
    s.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            s.qr = qr;
            s.status = 'qr';
            s.needsQr = true;
            console.log(`[${sessionId}] qr generated (scan within ~20s, it rotates)`);
        }

        if (connection === 'open') {
            s.status = 'connected';
            s.qr = null;
            s.needsQr = false;
            s.number = sock.user && sock.user.id ? sock.user.id.split(':')[0].split('@')[0] : null;
            noAutoStart.delete(sessionId);
            console.log(`[${sessionId}] connected as ${s.number}`);
        }

        if (connection === 'close') {
            const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
                ? lastDisconnect.error.output.statusCode
                : null;
            s.status = 'disconnected';
            s.qr = null;

            if (code === DisconnectReason.loggedOut) {
                // The phone unlinked this device. The saved creds are dead - a
                // reconnect loop here would spin forever, so drop them and wait
                // for a human to scan.
                console.log(`[${sessionId}] logged out on the phone - a new QR scan is needed`);
                noAutoStart.add(sessionId);
                s.needsQr = true;
                try {
                    fs.rmSync(sessionDir(sessionId), { recursive: true, force: true });
                } catch (err) {
                    console.warn(`[${sessionId}] could not clear the dead session folder:`, err.message);
                }
                sessions.delete(sessionId);
                return;
            }

            console.log(`[${sessionId}] connection closed (code ${code}) - reconnecting`);
            sessions.delete(sessionId);
            setTimeout(() => {
                startSession(sessionId, s.startedByHuman).catch((err) => {
                    console.error(`[${sessionId}] reconnect failed:`, err.message);
                });
            }, 3000);
        }
    });

    return s;
}

// Start (or resume) a session for a sender.
app.post('/sessions/:id/start', requireApiKey, requireSessionAccess, async (req, res) => {
    const sessionId = req.params.id;
    noAutoStart.delete(sessionId);
    try {
        const s = await startSession(sessionId, true);
        res.json({ ok: true, status: s.status });
    } catch (err) {
        console.error(`[${sessionId}] start failed:`, err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// Poll connection status.
app.get('/sessions/:id/status', requireApiKey, requireSessionAccess, (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.json({ ok: true, status: 'not_started' });
    res.json({ ok: true, status: s.status, number: s.number });
});

// Current QR code (data URL) while status === 'qr'.
app.get('/sessions/:id/qr', requireApiKey, requireSessionAccess, async (req, res) => {
    const s = sessions.get(req.params.id);
    if (!s || !s.qr) return res.json({ ok: true, qr: null });
    const dataUrl = await qrcode.toDataURL(s.qr);
    res.json({ ok: true, qr: dataUrl });
});

// Log a session out and drop it (lets a fresh QR be issued).
app.post('/sessions/:id/logout', requireApiKey, requireSessionAccess, async (req, res) => {
    const sessionId = req.params.id;
    const s = sessions.get(sessionId);
    if (s && s.sock) {
        try {
            await s.sock.logout();
        } catch (err) { /* already gone - the folder removal below is what matters */ }
    }
    await destroySession(sessionId);
    try {
        fs.rmSync(sessionDir(sessionId), { recursive: true, force: true });
    } catch (err) {
        console.warn(`[${sessionId}] could not remove the session folder:`, err.message);
    }
    noAutoStart.add(sessionId);
    res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------
function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
        }),
    ]).finally(() => clearTimeout(timer));
}

const LOOKUP_TIMEOUT_MS = 12000;
const SEND_TIMEOUT_MS = 25000;
const HEAL_WAIT_MS = 15000;      // 15 + 12 + 25 = 52s < the caller's 60s

const numberIdCache = new Map();   // "session|digits" -> { jid, at }
const NUMBER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Bring a session up without asking anyone to scan. A folder with saved creds
 *  only needs a reconnect - the QR is a one-time thing. */
async function healSession(sessionId) {
    let s = sessions.get(sessionId);
    if (s && s.status === 'connected') return s;
    if (s && s.status === 'qr') return null;          // genuinely needs a human
    if (!hasSavedLogin(sessionId)) return null;       // never scanned

    if (!s || s.status === 'disconnected') {
        console.log(`[${sessionId}] not connected on send - reconnecting from saved creds`);
        noAutoStart.delete(sessionId);
        await startSession(sessionId, false);
    }

    const until = Date.now() + HEAL_WAIT_MS;
    while (Date.now() < until) {
        s = sessions.get(sessionId);
        if (!s || s.status === 'qr') return null;
        if (s.status === 'connected') return s;
        await new Promise((r) => setTimeout(r, 300));
    }
    return null;   // still connecting; the caller retries
}

async function resolveSendTarget(req, res) {
    const { session, phone } = req.body || {};
    let s = sessions.get(session);
    if (!s || s.status !== 'connected') {
        s = await healSession(session);
    }
    if (!s || s.status !== 'connected') {
        const cur = sessions.get(session);
        const needsScan = cur && cur.status === 'qr';
        res.status(409).json({
            ok: false,
            error: needsScan
                ? `session '${session}' needs a QR scan`
                : (cur && cur.status === 'starting'
                    ? 'جاري إعادة الاتصال بالواتساب، حاول مرة اخرى بعد دقيقة.'
                    : `session '${session}' not connected`),
        });
        return null;
    }

    const digits = String(phone || '').replace(/\D/g, '');
    if (!digits) {
        res.status(400).json({ ok: false, error: 'invalid phone' });
        return null;
    }

    const cacheKey = `${session}|${digits}`;
    const hit = numberIdCache.get(cacheKey);
    if (hit && Date.now() - hit.at < NUMBER_CACHE_TTL_MS) {
        return { s, jid: hit.jid };
    }

    const t0 = Date.now();
    let found;
    try {
        found = await withTimeout(s.sock.onWhatsApp(digits), LOOKUP_TIMEOUT_MS, 'number lookup');
    } catch (e) {
        // The check is a nicety - sending to "<digits>@s.whatsapp.net" works on
        // its own. Failing the send because the lookup was slow is worse than
        // sending and letting the send report a real problem.
        console.warn(`[${session}] ${e.message} (${Date.now() - t0}ms) - sending without it`);
        return { s, jid: `${digits}@s.whatsapp.net` };
    }
    console.log(`[${session}] number lookup took ${Date.now() - t0}ms`);

    const entry = Array.isArray(found) ? found[0] : null;
    if (!entry || !entry.exists) {
        res.status(400).json({ ok: false, error: `الرقم ${digits} غير مسجل على واتساب` });
        return null;
    }

    const jid = entry.jid || `${digits}@s.whatsapp.net`;
    numberIdCache.set(cacheKey, { jid, at: Date.now() });
    return { s, jid };
}

// Look up numbers: are they on WhatsApp, and what a business account shows publicly.
// body: { session, phones: ["2010...", ...] }
// Paced on purpose: WhatsApp bans an account that queries numbers in bursts.
const LOOKUP_MAX_PHONES = 25;
const LOOKUP_GAP_MS = Number(process.env.LOOKUP_GAP_MS || 400);
const LOOKUP_AT_ONCE = Number(process.env.LOOKUP_AT_ONCE || 4);
// A personal number has no business profile and the request simply never answers, so this waits
// seconds, not the 12 a send is allowed.
const PROFILE_TIMEOUT_MS = Number(process.env.PROFILE_TIMEOUT_MS || 3500);
const lookupCache = new Map();   // digits -> { at, result }
const LOOKUP_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function lookupOne(sock, digits) {
    const hit = lookupCache.get(digits);
    if (hit && Date.now() - hit.at < LOOKUP_CACHE_TTL_MS) return { ...hit.result, cached: true };
    const found = await withTimeout(sock.onWhatsApp(digits), LOOKUP_TIMEOUT_MS, 'number lookup');
    const entry = Array.isArray(found) ? found[0] : null;
    if (!entry || !entry.exists) {
        const missing = { phone: digits, exists: false };
        lookupCache.set(digits, { at: Date.now(), result: missing });
        return missing;
    }
    const jid = entry.jid || `${digits}@s.whatsapp.net`;
    const result = { phone: digits, exists: true, name: entry.verifiedName || '' };
    const [profiled, abouted, pictured] = await Promise.allSettled([
        withTimeout(sock.getBusinessProfile(jid), PROFILE_TIMEOUT_MS, 'business profile'),
        withTimeout(sock.fetchStatus(jid), PROFILE_TIMEOUT_MS, 'about'),
        withTimeout(sock.profilePictureUrl(jid, 'image'), PROFILE_TIMEOUT_MS, 'photo'),
    ]);
    const profile = profiled.status === 'fulfilled' ? profiled.value : null;
    if (profile) {
        result.name = result.name || profile.business_name || '';
        result.description = profile.description || '';
        result.address = profile.address || '';
        result.website = (profile.website && profile.website[0]) || '';
        result.email = profile.email || '';
        const category = profile.category || (profile.categories && profile.categories[0]);
        result.category = (category && (category.name || category)) || '';
    }
    if (abouted.status === 'fulfilled' && Array.isArray(abouted.value)) {
        const row = abouted.value[0];
        result.about = (row && row.status && row.status.status) || '';
    }
    if (pictured.status === 'fulfilled') result.photo = pictured.value || '';
    lookupCache.set(digits, { at: Date.now(), result });
    return result;
}

app.post('/lookup', requireApiKey, requireSessionAccess, async (req, res) => {
    const { session, phones } = req.body || {};
    if (!session || !Array.isArray(phones) || !phones.length) {
        return res.status(400).json({ ok: false, error: 'session and phones are required' });
    }
    if (phones.length > LOOKUP_MAX_PHONES) {
        return res.status(400).json({ ok: false, error: `at most ${LOOKUP_MAX_PHONES} numbers per request` });
    }
    let s = sessions.get(session);
    if (!s || s.status !== 'connected') s = await healSession(session);
    if (!s || s.status !== 'connected') {
        return res.status(409).json({ ok: false, error: `session '${session}' not connected` });
    }
    const t0 = Date.now();
    const results = [];
    for (let at = 0; at < phones.length; at += LOOKUP_AT_ONCE) {
        const slice = phones.slice(at, at + LOOKUP_AT_ONCE).map((phone) => String(phone || '').replace(/\D/g, ''));
        const batch = await Promise.all(slice.map(async (digits, index) => {
            if (!digits) return { phone: String(phones[at + index] || ''), exists: false, error: 'invalid phone' };
            try {
                return await lookupOne(s.sock, digits);
            } catch (e) {
                return { phone: digits, exists: false, error: e.message || String(e) };
            }
        }));
        results.push(...batch);
        if (LOOKUP_GAP_MS && at + LOOKUP_AT_ONCE < phones.length) {
            await new Promise((done) => setTimeout(done, LOOKUP_GAP_MS));
        }
    }
    console.log(`[${session}] looked up ${results.length} number(s) in ${Date.now() - t0}ms`);
    res.json({ ok: true, results });
});

// Send a text message. body: { session, phone, message }
app.post('/send', requireApiKey, requireSessionAccess, async (req, res) => {
    const { session, phone, message } = req.body || {};
    if (!session || !phone || !message) {
        return res.status(400).json({ ok: false, error: 'session, phone and message are required' });
    }
    try {
        const target = await resolveSendTarget(req, res);
        if (!target) return;
        const t0 = Date.now();
        const sent = await withTimeout(
            target.s.sock.sendMessage(target.jid, { text: message }),
            SEND_TIMEOUT_MS,
            'send',
        );
        rememberSent(session, sent);
        console.log(`[${session}] send took ${Date.now() - t0}ms`);
        res.json({ ok: true, id: sent && sent.key ? sent.key.id : null });
    } catch (e) {
        console.error(`[${session}] send failed:`, e.message || e);
        const timedOut = /timed out/.test(e.message || '');
        res.status(timedOut ? 504 : 500).json({
            ok: false,
            error: timedOut
                ? 'انتهت المهلة. قد تكون الرسالة قد أُرسلت بالفعل - تحقق قبل إعادة المحاولة.'
                : (e.message || String(e)),
        });
    }
});

// Send a document with an optional caption.
// body: { session, phone, message, filename, pdf_base64 }
app.post('/send-document', requireApiKey, requireSessionAccess, async (req, res) => {
    const { session, phone, message, filename, pdf_base64 } = req.body || {};
    if (!session || !phone || !pdf_base64) {
        return res.status(400).json({ ok: false, error: 'session, phone and pdf_base64 are required' });
    }
    try {
        const target = await resolveSendTarget(req, res);
        if (!target) return;
        const t0 = Date.now();
        const sent = await withTimeout(
            target.s.sock.sendMessage(target.jid, {
                document: Buffer.from(pdf_base64, 'base64'),
                mimetype: 'application/pdf',
                fileName: filename || 'document.pdf',
                caption: message || undefined,
            }),
            SEND_TIMEOUT_MS,
            'send-document',
        );
        rememberSent(session, sent);
        console.log(`[${session}] send-document took ${Date.now() - t0}ms`);
        res.json({ ok: true, id: sent && sent.key ? sent.key.id : null });
    } catch (e) {
        console.error(`[${session}] send-document failed:`, e.message || e);
        const timedOut = /timed out/.test(e.message || '');
        res.status(timedOut ? 504 : 500).json({
            ok: false,
            error: timedOut
                ? 'انتهت المهلة. قد يكون الملف قد أُرسل بالفعل - تحقق قبل إعادة المحاولة.'
                : (e.message || String(e)),
        });
    }
});

// ---------------------------------------------------------------------------
// Keeping sessions up
// ---------------------------------------------------------------------------
async function restoreSessions() {
    const ids = savedSessionIds();
    if (!ids.length) {
        console.log('[restore] no saved sessions found');
        return;
    }
    // A socket costs ~40MB, so unlike v1 there is no reason to cap or stagger
    // this - the browsers are what could not be started all at once.
    console.log(`[restore] starting ${ids.length} saved session(s)`);
    for (const id of ids) {
        try {
            await startSession(id, false);
        } catch (err) {
            console.error(`[restore] ${id} failed:`, err.message);
        }
    }
}

function startWatchdog() {
    const INTERVAL_MS = 45000;
    setInterval(async () => {
        for (const id of savedSessionIds()) {
            if (noAutoStart.has(id)) continue;
            const s = sessions.get(id);
            if (s && s.status !== 'disconnected') continue;
            console.log(`[watchdog] ${id} is ${s ? s.status : 'not running'} - starting it`);
            try {
                await startSession(id, false);
            } catch (err) {
                console.error(`[watchdog] ${id} failed:`, err.message);
            }
        }
    }, INTERVAL_MS);
}

app.listen(PORT, () => {
    console.log(`wa-gateway-v2 (baileys) listening on http://localhost:${PORT}`);
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    restoreSessions().catch((err) => console.error('[restore] failed:', err.message));
    startWatchdog();
});
