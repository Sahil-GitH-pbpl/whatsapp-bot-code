## WhatsApp Control Panel

A multi-account WhatsApp Web dashboard with persistent MySQL storage. Each WhatsApp number (account) tracks its own chats, messages (including media as base64), and QR authentication state.

### Features
- Manage multiple WhatsApp numbers simultaneously.
- Scan QR codes in the browser to authenticate each account.
- Persist chats and every inbound message (text + media) in MySQL.
- View conversations and download attachments from the UI.
- Send messages to saved chats, raw numbers, or WhatsApp IDs.
- Dockerized stack: Node.js app + MySQL.

### Requirements
- Node.js 18+ (development).
- MySQL 8 (or compatible).
- `docker` and `docker compose` if you prefer containers.

### Environment Variables

`index.js` reads the following (defaults shown):

```
PORT=3004
DB_HOST=127.0.0.1
DB_USER=root
DB_PASS=
DB_NAME=whatsapp_control
WWEB_HEADLESS=true
WWEB_VERSION=2.3000.1031002532
WWEB_VERSION_CACHE=local
WAPP_API_BASE_URL=http://localhost:3004    # change when the dashboard is behind a reverse proxy
WAPP_SEND_ACCOUNT_ID=1                     # account used for automated replies
WAPP_READ_ACCOUNT_ID=1                     # leave blank to reuse the send account for inbound automation
WAPP_STORE_OUTGOING=false                  # set true only if you want to log sent messages
WAPP_WIT_TIMEOUT=5                         # Wit.ai request timeout (seconds)
WAPP_FAKE_WIT_MODE=false                   # true to use keyword-based Wit fallback
WAPP_FAKE_WIT_KEYWORDS=ok,pickup,collection,yes
WAPP_EMPLOYEE_NUMBERS=919319824441 (Ritu),917838104597 (Shahana),918287906213 (Maria),918287906795 (Office),919999910870 (Salim),919810030372 (Vipul),919810637037 (Vishu),919315144233 (Aarish)
WAPP_EMPLOYEE_AUTHOR_IDS=57810528256249@lid (Ritu linked session),256237899923702@lid (Vipul),86127180513442@lid (Maria),89335487529073@lid (Salim),163140104925423@lid (Shahana),131877155406046@lid (Office device),91096340283417@lid (Aarish)
WAPP_OVERRIDE_REPLY_TARGET=                # optional: force auto-replies to a specific chat/number
WIT_AI_TOKEN=    # leave blank to skip Wit.ai automation
WIT_AI_SESSION=prod2g
```

Set `WWEB_HEADLESS=false` if you need to watch Chromium while developing locally.
`WWEB_VERSION` pins WhatsApp Web to a version known to work with `whatsapp-web.js`; update it only when you deliberately refresh the cached bundle. `WWEB_VERSION_CACHE` should stay `local` so the client reuses the files inside `.wwebjs_cache`.

### Local Development

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start a MySQL instance and create a database matching `DB_NAME`.
3. Export the env vars (or use an `.env` file).
4. Run the server:
   ```bash
   npm start
   ```
5. Open [http://localhost:3004](http://localhost:3004) and add an account. Scan the QR that pops up.

The server automatically initializes the schema defined in `db/schema.sql`.

### Docker

```
docker compose up --build -d
```

The stack exposes:
- App: `http://localhost:3004`
- MySQL: `localhost:3306` (user `wa_user`, password `wa_pass`, root password `root_pass`)
- phpMyAdmin: `http://localhost:8080` (log in with the MySQL credentials above)

Connect with any MySQL client using `mysql://wa_user:wa_pass@localhost:3306/wa_dashboard` (or the root password above for admin tasks).

App data (WhatsApp sessions) persists in the `session_data` volume, WhatsApp web cache in `wweb_cache`, and the database persists in `mysql_data`.

### Pushing Images to Docker Hub

1. Log in: `docker login`.
2. Build: `docker compose build`.
3. Tag the app image (replace `yourname`): `docker tag wa-dashboard yourname/wa-dashboard:latest`.
4. Push: `docker push yourname/wa-dashboard:latest`.

If you prefer compose to emit the tag automatically, add `image: yourname/wa-dashboard:latest` under the `app` service before step 2.

Notes on WhatsApp Web:
- Headless Chromium runs in the container (`PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser`).
- We pin `WWEB_VERSION`/`WWEB_VERSION_CACHE` so WhatsApp Web stays on a bundle known to work with `whatsapp-web.js`. When Meta ships breaking changes, bump these two values only after verifying the new version locally.
- The QR modal bundles `public/vendor/qrcode.min.js` so Docker builds don't rely on `node_modules` being present on the host.

### Built-in Automation Flow

Inbound messages for `WAPP_READ_ACCOUNT_ID` are persisted in `messages` but outbound traffic is ignored unless `WAPP_STORE_OUTGOING=true`. As soon as a new inbound row is saved, the Node service:

1. Mirrors the payload into `stewindiawhatsapp` (including `sender_whatsapp_id`, `messages_id`, and `automation_message_id`).
2. Skips the record if the sender matches any entry from `WAPP_EMPLOYEE_NUMBERS` or `WAPP_EMPLOYEE_AUTHOR_IDS`.
3. Looks up the chat in the `center` table and, if a mapping exists, runs Wit.ai (or the keyword fallback when `WAPP_FAKE_WIT_MODE=true`). Only `"Ok"` responses move forward.
4. Creates `pickup` entries and updates `stewindiawhatsapp.status` for that day.
5. Sends the canned acknowledgement through `/api/accounts/{WAPP_SEND_ACCOUNT_ID}/send` when `wabacenter` contains the corresponding `centerid`. `WAPP_OVERRIDE_REPLY_TARGET` can redirect every automated reply to a test chat/number (`digits` turn into `*@c.us` automatically).

This is the same flow that used to live in `scripts/process_whatsapp_message.py`, but it now executes automatically without running a separate Python process.

### Folder Highlights
- `index.js` – Express API + SSE stream.
- `services/accountManager.js` – spins up WhatsApp clients per account and persists chats/messages.
- `services/storage.js` – MySQL helpers for accounts, chats, messages, and media.
- `public/` – Frontend dashboard.
- `db/schema.sql` – Table definitions.

### Notes
- Every media message stores base64 data in MySQL for easy retrieval. Monitor DB size if you expect heavy media usage.
- Chrome runs headless in Docker. Use the QR modal provided by the UI for authentication.
- The SSE stream broadcasts status, QR refreshes, and message events so the UI stays in sync across sessions.
