# wa-gateway-v2

Unofficial multi-session WhatsApp gateway, on [Baileys](https://github.com/WhiskeySockets/Baileys).

Same HTTP API as `wa-gateway` v1, so an app pointed at this port needs **no code
change** — only `WhatsappConfig.gateway_url` moves from `:3001` to `:3002`.

## Why

v1 ran a real Chromium per sender. That is where nearly every failure came from:

| | v1 (whatsapp-web.js) | v2 (Baileys) |
|---|---|---|
| How it connects | drives headless Chromium | WebSocket, no browser |
| RAM per sender | 300–800 MB | ~30–50 MB |
| `Cannot read properties of undefined (reading 'getChat')` | page reloaded, injected code gone | cannot happen — nothing is injected |
| `Attempted to use detached Frame` | yes | cannot happen — no page |
| Sessions stuck at `starting` | browser too slow to boot | connects in seconds |
| Reconnect after a drop | rebuild a browser, 30–60 s | automatic, seconds |

Measured on one active session: the entire v2 process used **75 MB**, against
**1.48 GB** for a single v1 session.

## Still unofficial

This speaks WhatsApp's multi-device protocol directly. It violates WhatsApp's
Terms of Service and **sender numbers can be banned**. Keep volume low and the
pacing conservative — the sending app's delay floor and daily caps are what
protect the number, and they are unchanged.

## Install

```bash
npm install
cp .env.example .env      # set API_KEY
node index.js             # or: pm2 start index.js --name wa-gateway-v2
```

Runs on port 3002 by default, so it can run **alongside** v1 on 3001 while you
migrate.

## API

Identical to v1. Every route except `/provision` needs `X-API-KEY`.

| Method | Path | Body / notes |
|---|---|---|
| POST | `/provision` | `{prefix, existing_key?}` — loopback only; mints a scoped key |
| POST | `/sessions/:id/start` | begins a session (or resumes a saved one) |
| GET | `/sessions/:id/status` | `not_started` \| `starting` \| `qr` \| `connected` \| `disconnected` |
| GET | `/sessions/:id/qr` | `{qr: "data:image/png;base64,..."}` while status is `qr` |
| POST | `/sessions/:id/logout` | unlinks and deletes the saved login |
| POST | `/send` | `{session, phone, message}` |
| POST | `/send-document` | `{session, phone, message, filename, pdf_base64}` |

`phone` is digits only, E.164 without `+` (e.g. `201234567890`).

### Keys

- `API_KEY` — master, may touch any session id.
- Scoped keys (`SCOPED_API_KEYS=prefix:key,...` in `.env`, or minted via
  `/provision` into `provisioned-keys.json`) may only touch session ids starting
  with `<prefix>-`. Both files are watched, so adding a client needs no restart.

## Sessions

Logins live in `.baileys_auth/session-<id>/`. They survive restarts: on boot
every saved session reconnects by itself, and a watchdog re-checks every 45 s.
A QR scan is needed only the first time, or after the phone unlinks the device.

## Migrating from v1

Logins do **not** carry over — v1 stored a Chromium profile, v2 stores protocol
credentials. Each sender scans a QR once.

Suggested order, with no downtime:

1. Run v2 on 3002 next to v1 on 3001.
2. Pick one client, change their `gateway_url` to `http://localhost:3002`.
3. They press اتصال / QR and scan once, then send a test message.
4. Repeat per client. Anything wrong — point that client back at 3001.
5. When every client is on 3002, stop v1.
