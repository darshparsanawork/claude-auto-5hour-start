# Claude Auto Reset Sender

A tiny Node app with a basic web UI. You **connect one or more claude.ai
accounts**; the app detects each account's usage **reset time** and
automatically sends a message **5 minutes after every reset**. There is no
start time to set — just connect an account and it runs.

The message and model are configurable in Settings (defaults: `hi` sent with
the **Sonic** model, `claude-sonnet-4-5`).

## How it works

- `server.js` — Express server + per-account reset scheduler + claude.ai
  internal-API client.
- `public/index.html` — the frontend (settings, add/connect accounts, live log).
- Auth comes from each account's exported claude.ai cookies, pasted in the UI.

## Storage

State (settings + connected accounts/cookies) is persisted to a **mounted data
volume** when one is available, otherwise it is kept **in memory** (not
persisted across restarts):

1. `DATA_DIR` env var, if set and writable.
2. Otherwise `/data`, if writable.
3. Otherwise in-memory only.

The UI shows which mode is active under **Storage**.

> ⚠️ Cookies are live session tokens. When persisted they live in
> `<data dir>/accounts.json` — keep that volume private. If a token leaks, log
> out of claude.ai everywhere to rotate it. Nothing secret is committed to git.

## Setup

```bash
npm install
npm start          # optionally: DATA_DIR=/path/to/data npm start
```

Open http://localhost:3000

## Using the UI

- **Settings:** set the **Message** to send and the **Model** (defaults to the
  Sonic model `claude-sonnet-4-5`; edit if your account uses a different id —
  a rejected id falls back to the account default). Toggle **Automation
  enabled** and click **Save settings**.
- **Add account:** export your claude.ai cookies (e.g. "Cookie-Editor"
  extension → Export → JSON), optionally name it, paste the JSON, **Add
  account**. Needs at least the `sessionKey` cookie (`lastActiveOrg`
  recommended).
- Each account row shows its **email**, an **ACTIVE/INACTIVE** badge, usage
  left, the **next reset time (IST)**, and the scheduled **auto-send time
  (IST)** = reset + 5 min. Buttons: **Send now**, **Refresh usage**,
  **Recheck**, **Remove**.

## How scheduling works

When an account connects (or on startup), the app verifies it, reads its usage
reset time, and schedules an auto-send for **reset + 5 minutes**. Each send
reads the fresh reset time from the response and reschedules the next one, so
each account self-perpetuates on its own real reset cadence. If a reset time
can't be read without sending, the app sends one message to start the cycle.

## Notes

- This uses claude.ai's **internal/unofficial** web API. If Anthropic changes
  it, the create-conversation / send-message calls may need updating. Watch the
  log panel for errors.
- Keep the process running (e.g. `pm2`, `screen`, systemd, or a container with
  the data volume mounted) for auto-sends to keep firing.
