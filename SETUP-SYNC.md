# Sanstyle cloud sync — one-time setup

The live site syncs through its own `/api` routes (deployed automatically by
Vercel from the `api/` folder). Those routes talk to your two Google Drive
folders with a Google identity you configure once. No Google sign-in ever
happens in the browser; the site only asks for the passcode.

What you get once this is configured:

- Open the site → passcode → your full letterform library loads from Drive,
  identical on every device. Nothing lives only in one browser anymore.
- New photos dropped into the **inbox folder** (from the Drive app on your
  phone, or from the site itself) are offered for extraction on open, and
  every photo in the folder shows in the Glyphs tab, ready to re-extract.
- Every letterform is mirrored into the **letterforms folder** as a
  standalone SVG (named like `S-caps__k3v9x2q1.svg`) next to `library.json`,
  and kept in step automatically — add, delete, or re-nudge in the Glyphs
  tab and Drive follows. The SVGs open straight in Illustrator.

## Which identity: yourself, or a robot?

There are two ways to let the site into Drive. **Pick one.**

| | Sign in as yourself (OAuth) | Service account (robot) |
| --- | --- | --- |
| Works with a personal Gmail | **yes** | reads only — writes fail (see below) |
| Works with Google Workspace | yes | yes, if both folders live in a **Shared Drive** |
| Who owns the files the site creates | you | the robot / the Shared Drive |
| Setup | OAuth client + one consent click (5 min) | JSON key + share two folders (5 min) |

**Why the robot can't write to a personal Drive:** since 2025 Google gives
service accounts no storage quota, so any file a service account tries to
create in a My Drive folder fails with
`403 Service Accounts do not have storage quota. Leverage shared drives…` —
exactly the error a red **Sync error** pill shows on click. Reads still
work, which is why the inbox lists photos while every save fails.

The fix is either of the two setups below. If you already have a working
robot on a Shared Drive, nothing changes.

## Option A — sign the site in as yourself (recommended for Gmail)

1. Go to [console.cloud.google.com](https://console.cloud.google.com), create
   a project (any name), then **APIs & Services → Library → Google Drive
   API → Enable**.
2. **APIs & Services → OAuth consent screen**: External, give it a name,
   your email as support/developer contact, save. Then set the publishing
   status to **In production** (the "unverified app" warning is fine — you
   are the only user; leaving it in *Testing* makes Google expire the
   sign-in every 7 days).
3. **Credentials → Create credentials → OAuth client ID → Desktop app.**
   Copy the client ID and client secret.
4. In the repo, run the one-time helper and follow its link, signed in as
   the Google account that owns the two folders:

   ```bash
   node tools/get_refresh_token.mjs <CLIENT_ID> <CLIENT_SECRET>
   ```

   Approve (click through "Google hasn't verified this app → Continue").
   The script prints the three values for the next step.
5. Vercel → your project → **Settings → Environment Variables** (all
   environments), then **redeploy**:

   | Name | Value |
   | --- | --- |
   | `GOOGLE_OAUTH_CLIENT_ID` | from step 3 |
   | `GOOGLE_OAUTH_CLIENT_SECRET` | from step 3 |
   | `GOOGLE_OAUTH_REFRESH_TOKEN` | printed by the helper |
   | `SANSTYLE_PASSCODE` | your passcode (defaults to `3754` if unset) |

   The service-account variables can stay or go; when all three OAuth
   values are present the site uses your account.

Nothing to share: the folders are already yours. The site now creates
files as you, with your storage.

## Option B — a service account on a Shared Drive (Google Workspace)

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and
   create a project (name it anything — `sanstyle` works).
2. **APIs & Services → Library** → search **Google Drive API** → **Enable**.
3. **APIs & Services → Credentials → Create credentials → Service account.**
   Name it (e.g. `sanstyle-robot`), click through — no roles needed.
4. Open the new service account → **Keys → Add key → Create new key → JSON**.
   A `.json` file downloads. It contains `client_email` and `private_key`.
5. In Google Drive, create a **Shared Drive** (left sidebar → Shared drives
   → New), move or create the inbox and letterforms folders inside it, and
   add the `client_email` as a **Content manager** of the Shared Drive.
   Files created there belong to the drive, not to the robot, which is what
   gets around the quota rule.
6. Vercel → **Settings → Environment Variables** (all environments), then
   **redeploy**:

   | Name | Value |
   | --- | --- |
   | `GOOGLE_SERVICE_ACCOUNT_EMAIL` | the `client_email` from the JSON |
   | `GOOGLE_SERVICE_ACCOUNT_KEY` | the `private_key` from the JSON — paste the whole thing including `-----BEGIN PRIVATE KEY-----`; literal `\n` sequences are fine |
   | `DRIVE_INBOX_FOLDER_ID` | the inbox folder's id (from its URL) |
   | `DRIVE_LIBRARY_FOLDER_ID` | the letterforms folder's id |
   | `SANSTYLE_PASSCODE` | your passcode (defaults to `3754` if unset) |

## Checking it

Open the live site: it should show the passcode gate, and the topbar shows
a **Synced** pill after unlocking. If the pill is red, click it: it runs
`/api/diag` and reports which identity is in use and which of token, inbox,
letterforms folder and a write test failed — with the fix when it is the
quota rule.

## Daily workflow

- **On the street**: shoot the piece → share the photo to the inbox folder
  from the Drive app. Next time you open the site, it offers to extract.
- **At the desk**: drop photos on the site with "Store uploads in the Drive
  inbox" checked — they're archived to Drive and processed in one motion.
- **Any photo, again**: the Glyphs tab shows every photo in the inbox;
  grayed ones already gave letterforms. Click any to extract from it again,
  or **Re-scan Drive photos** on the Capture tab to queue them all.
- **Anywhere**: capture, retag, delete, nudge — every change lands in
  `library.json` + the SVG mirror within a couple of seconds ("Synced"
  pill).

## Notes & limits

- **Security is passcode-grade, not bank-grade.** The passcode is checked
  server-side on every request (the Google credentials never reach the
  browser), but anyone you give the passcode to can read and write the
  library. Don't reuse a password you care about; change it via
  `SANSTYLE_PASSCODE`.
- **Photos uploaded through the site** are re-encoded to ≤1800 px JPEGs
  (Vercel's request limit is ~4.5 MB). Photos you add straight to the Drive
  folder yourself stay full resolution and are only ever *read*.
- **Conflict model**: personal-tool simple. Variants merge by id (nothing
  is ever lost by syncing), and for settings the most recent push wins.
  If sync fails, the pill turns red — click it to see why and retry;
  everything keeps working locally in the meantime.
- Without the env vars the site runs local-only, no passcode gate.
  `library.json` also round-trips with the Glyphs tab's Export/Import
  buttons, which double as a manual backup path.
