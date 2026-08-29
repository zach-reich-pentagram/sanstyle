# Sanstyle cloud sync — one-time setup

The live site syncs through its own `/api` routes (deployed automatically by
Vercel from the `api/` folder). Those routes talk to your two Google Drive
folders as a **service account** — a robot Google identity that you share the
folders with once. No Google sign-in ever happens in the browser; the site
only asks for the passcode.

What you get once this is configured:

- Open the site → passcode → your full letterform library loads from Drive,
  identical on every device. Nothing lives only in one browser anymore.
- New photos dropped into the **inbox folder** (from the Drive app on your
  phone, or from the site itself) are offered for extraction on open.
- Every letterform is mirrored into the **letterforms folder** as a
  standalone SVG (named like `S-caps__k3v9x2q1.svg`) next to `library.json`,
  and kept in step automatically — add, delete, or re-nudge in the Glyphs
  tab and Drive follows. The SVGs open straight in Illustrator.

## 1. Create the service account (~5 minutes)

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and
   create a project (name it anything — `sanstyle` works).
2. **APIs & Services → Library** → search **Google Drive API** → **Enable**.
3. **APIs & Services → Credentials → Create credentials → Service account.**
   Name it (e.g. `sanstyle-robot`), click through — no roles needed.
4. Open the new service account → **Keys → Add key → Create new key → JSON**.
   A `.json` file downloads. It contains `client_email` and `private_key`.

## 2. Share the two folders with the robot

In Google Drive, share **both** folders with the `client_email` from the
JSON (it looks like `sanstyle-robot@…iam.gserviceaccount.com`), as
**Editor**:

- Inbox (photos): folder `1BNUkRRGWQsfPc5yoaia4rsuX8dUtli9s`
- Letterforms (SVGs + library.json): folder `1ckGGFq99lVayKplwzDKm3SQsY28o2_uU`

## 3. Add the environment variables in Vercel

Vercel → your project → **Settings → Environment Variables** (all
environments), then **redeploy**:

| Name | Value |
| --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | the `client_email` from the JSON |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | the `private_key` from the JSON — paste the whole thing including `-----BEGIN PRIVATE KEY-----`; literal `\n` sequences are fine |
| `SANSTYLE_PASSCODE` | your passcode (defaults to `3754` if unset) |

Optional (already default to your folders — only set if the folders change):
`DRIVE_INBOX_FOLDER_ID`, `DRIVE_LIBRARY_FOLDER_ID`.

That's it. Open the live site: it should show the passcode gate, and the
topbar shows a **Synced** pill after unlocking.

## Daily workflow

- **On the street**: shoot the piece → share the photo to the inbox folder
  from the Drive app. Next time you open the site, it offers to extract.
- **At the desk**: drop photos on the site with "Store uploads in the Drive
  inbox" checked — they're archived to Drive and processed in one motion.
- **Anywhere**: capture, retag, delete, nudge — every change lands in
  `library.json` + the SVG mirror within a couple of seconds ("Synced"
  pill). The Glyphs tab is the management surface.

## Notes & limits

- **Security is passcode-grade, not bank-grade.** The passcode is checked
  server-side on every request (the Google key never reaches the browser),
  but anyone you give the passcode to can read and write the library. Don't
  reuse a password you care about; change it via `SANSTYLE_PASSCODE`.
- **Photos uploaded through the site** are re-encoded to ≤1800 px JPEGs
  (Vercel's request limit is ~4.5 MB) and are owned by the service account,
  which has its own 15 GB of storage. Photos you add straight to the Drive
  folder yourself stay yours, full resolution, and are only ever *read*.
- **Conflict model**: personal-tool simple. Variants merge by id (nothing
  is ever lost by syncing), and for settings the most recent push wins.
  If sync fails, the pill turns red — click it to retry; everything keeps
  working locally in the meantime.
- Without the env vars the site runs exactly as before: local-only, no
  passcode gate. `library.json` also round-trips with the Glyphs tab's
  Export/Import buttons, which double as a manual backup path.
