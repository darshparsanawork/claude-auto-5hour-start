# Claude Auto 5-Hour Session Starter

A tiny Node app with a basic web UI. You pick the **next trigger time in IST**,
and from then on it automatically triggers **every 5 hours 3 minutes**.
A "trigger" = create a brand-new conversation on claude.ai and send a message
(`hi` by default).

This is handy for keeping a rolling 5-hour usage window "warm".

## How it works

- `server.js` — Express server + scheduler + claude.ai internal-API client.
- `public/index.html` — the frontend (set time, start/stop, test, live log).
- Auth comes from your exported claude.ai cookies in `cookies.json`.

## Setup

1. Install Node 18+ and dependencies:

   ```bash
   npm install
   ```

2. Export your claude.ai cookies (e.g. with the "Cookie-Editor" browser
   extension → Export → JSON) while logged in to https://claude.ai, and save
   them as `cookies.json` in this folder. The full array works as-is; only
   `sessionKey` and `lastActiveOrg` are strictly required.

   > ⚠️ **`cookies.json` is gitignored — never commit it.** It contains your
   > live session token. If it leaks, log out of claude.ai everywhere to
   > rotate it.

3. Run:

   ```bash
   npm start
   ```

4. Open http://localhost:3000

## Using the UI

- **Next trigger time (IST):** when the first message fires.
- **Message:** what gets sent (`hi` by default).
- **Save & Start:** schedules and arms the loop.
- **Trigger now (test):** fires immediately so you can confirm cookies work.
- **Stop:** pauses the loop.

After the first fire, the next is auto-scheduled at +5h3m, repeating forever.
Schedule state persists in `config.json`, so a restart resumes the loop (and
skips any slots missed while it was down).

## Notes

- This uses claude.ai's **internal/unofficial** web API. If Anthropic changes
  it, the create-conversation / send-message calls may need updating. Watch the
  log panel for errors.
- Keep the process running (e.g. `pm2`, `screen`, or a systemd service) for the
  loop to keep firing.
