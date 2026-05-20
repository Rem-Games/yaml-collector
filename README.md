# YAML Collector

Static GitHub Pages frontend for collecting Archipelago-style YAML files in shared rooms.

GitHub Pages cannot securely store shared data or enforce delete permissions by itself, so this project uses:

- GitHub Pages for the site
- Supabase for storage and server-side permission checks
- Browser cookies as capability tokens

## Required Supabase Hardening

Before using this in production, change these Supabase settings:

1. In `Project Settings -> Data API`, add `api` to `Exposed schemas`.
2. In that same screen, remove `public` from `Exposed schemas` if you are not using it for anything else.
3. Run `supabase/schema.sql`.
4. Use a Supabase publishable key if your project has one. The legacy anon key also works, but the publishable key is the current recommendation.

## What It Does

- Shows a `My Rooms` landing view for rooms this browser created or uploaded to
- Lets users save an optional Discord username for this browser's cookie-bound profile
- Lets users create rooms with a name, closing date, description, optional per-user YAML limit, and optional Discord username requirement
- Uploads `.yaml`, `.yml`, or `.txt` files into a room
- Splits combined `---`-delimited YAML uploads into individual room entries
- Lists room YAMLs as one row per player document using the root `name` and `game` fields
- Validates that each YAML has root `name`, root `game`, and a root section whose key matches the `game` value
- Rejects duplicate player names inside a room unless the root `name` contains `{player}`, `{PLAYER}`, `{number}`, or `{NUMBER}`
- Lets room creators edit the room name, closing time, per-user YAML limit, and Discord username requirement
- Lets room creators upload, replace, and remove a room-level `meta.yaml` without normal player YAML validation or upload-limit counting
- Lets room creators delete any YAML in their room before the room closes and delete the room itself
- Lets uploaders delete only their own YAMLs, and only before the room closes
- Sorts the room table by player or game, can filter to only the current browser's YAMLs, and can toggle saved Discord usernames next to player names
- Downloads one YAML at a time, `meta.yaml`, all YAMLs as a zip, or uploader bundles as a zip of `---`-joined files; zip downloads include `meta.yaml` when present
- Names uploader bundle files with the uploader's Discord username when one is stored on that uploader's entries
- Uses this separator when bundling YAMLs:

```yaml

---

```

between each stored entry

## Security Model

This is cookie-based capability control, not account auth.

- Each browser gets an uploader token cookie
- Optional Discord usernames are saved server-side against the uploader token hash derived from that cookie
- Rooms can require a Discord username before upload; Supabase enforces this and stores the current Discord username on each YAML entry
- Updating a profile to a non-empty Discord username updates that browser's existing YAML entries in open rooms; clearing the profile or closing a room does not erase usernames already saved on entries
- Creating a room also creates a room-admin token cookie for that room
- Only SHA-256 hashes of those tokens are stored in the database
- Room creation, room updates, uploads, room deletion, YAML deletion, and `meta.yaml` management are enforced server-side in Supabase SQL functions

If a browser's cookies are cleared, that browser loses its delete rights.

## Files

- `index.html`
- `styles.css`
- `app.js`
- `config.js`
- `supabase/schema.sql`

## Supabase Setup

1. Create a Supabase project.
2. Open the SQL editor.
3. Run `supabase/schema.sql`.
4. Copy your project URL and publishable key into `config.js`.

`config.js` should end up like:

```js
window.APP_CONFIG = {
  supabaseUrl: "https://your-project.supabase.co",
  supabaseKey: "your-publishable-or-anon-key"
};
```

## GitHub Pages Deployment

`config.js` should remain local-only. This repo includes a GitHub Actions deploy workflow that generates `config.js` from repository secrets during publish.

1. Put these files in a GitHub repo.
2. Add these GitHub repository secrets:
   `SUPABASE_URL`
   `SUPABASE_KEY`
3. In GitHub, set Pages to deploy from `GitHub Actions`.
4. Push to `main` or run the `Deploy GitHub Pages` workflow manually.
5. Visit the published site and create a room.

## Local Testing

Use a staging Supabase project for local testing so you do not mix trial data with production.

1. Fill in `config.js` with your staging Supabase URL and publishable key.
2. Start a local static server:

```bash
bash serve-local.sh
```

3. Open `http://localhost:4173`.
4. Make changes in `index.html`, `styles.css`, or `app.js` and refresh the browser.
5. If you change the database schema, rerun `supabase/schema.sql` in the staging Supabase project.

## Notes About Archipelago YAML

Archipelago YAML documents are stored as raw text instead of being parsed and re-serialized. Combined uploads are split on a `---` separator line with optional blank lines around it. The room list only extracts the root `name` and `game` fields for display. That avoids breaking:

- weighted options
- custom game sections
- multi-document YAML bundles
- Archipelago-specific conventions layered on top of standard YAML

If you already deployed the older schema, rerun `supabase/schema.sql`. This version moves the app tables/functions into the `api` schema, hardens function execution, adds room metadata fields, adds `submission_id` plus `document_index`, and adds cookie-bound Discord profile fields plus the optional room Discord requirement.

## Deployment Secret Notes

- `SUPABASE_URL` is public at runtime, but keeping it in a secret avoids committing it to Git.
- `SUPABASE_KEY` should contain your Supabase publishable key if available, or the legacy anon key if not.
- Never put the Supabase `service_role` key into this project or GitHub Pages.
