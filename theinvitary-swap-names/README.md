# Invites platform

Digital wedding invitation shop on Cloudflare (free plan): shop pages, "try with your names" previews, emailed preview links, live invitations, and per-guest links.

## How it works

- `public/` is plain HTML, served directly by Cloudflare: the shop (`/`, `/templates/<theme>/`), the themes (`/themes/<theme>/`) and your admin panel (`/admin/`).
- `src/worker.js` handles the dynamic routes. It fetches a theme file and fills in the customer's settings before sending it, so one theme file serves every customer and nothing is ever rebuilt.
- `schema.sql` is the database: `drafts` (try-ons), `invitations` (paid, live), `guests` and `rsvps`.

## Themes

| Key | Name | Audience | Events |
|---|---|---|---|
| `ever-after` | Ever After | English / global | welcome, ceremony, reception, brunch |
| `signature` | Signature | Desi: embroidered gate tied with silk, a film per function, ivory linen inside | mehndi, nikkah, baraat, walima |
| `resham` | Resham | Desi: sage silk throughout, a film per function | mehndi, nikkah, baraat, walima |

Ever After has an RSVP form. Replies from live invitations are saved and shown in `/admin/` with a headcount, meal totals and a copy-to-spreadsheet button. In previews the form works but nothing is saved.

| URL | What it shows |
|---|---|
| `/templates/signature/`, `/templates/ever-after/`, `/templates/resham/` | Shop pages with price, live sample and the try-on form |
| `/try/<id>` | A customer's preview with their names and functions |
| `/<slug>` | A paid invitation, e.g. `/ayesha-weds-hamza` |
| `/<slug>/<guest>` | The same invitation for one guest: greeted by name, their seats, only their functions |
| `/admin/` | Previews, make-live, edit content, guest links, RSVP replies |

## One-time setup

You need Node.js 18+ and a free Cloudflare account.

```bash
npm install
npx wrangler login                     # opens the browser, sign in to Cloudflare
npx wrangler d1 create invites         # copy the database_id it prints into wrangler.toml
npm run db:remote                      # creates the tables in your live database
npx wrangler secret put ADMIN_TOKEN    # type a long password for /admin
npx wrangler secret put RESEND_API_KEY # from resend.com → API Keys (free)
npm run deploy                         # prints your live URL, e.g. invites-platform.<you>.workers.dev
```

Then edit `wrangler.toml` → `[vars]`: your WhatsApp number and brand name, and deploy again.

### Email
Until you verify a domain in Resend, the sender `onboarding@resend.dev` only delivers to the email you signed up to Resend with. That's fine for testing. Before selling: add your domain in Resend → Domains, add the DNS records it shows, then set `FROM_EMAIL = "Dawat Invites <hello@yourdomain.com>"`.

Without `RESEND_API_KEY` everything still works; the email step is skipped and logged.

### Custom domain
Cloudflare dashboard → Workers → invites-platform → Settings → Domains & Routes → add your domain. Then set `SITE_URL` in `wrangler.toml` so emailed links and WhatsApp previews use it.

## Running locally

```bash
echo "ADMIN_TOKEN=test-admin" > .dev.vars
npm run db:local
npm run dev            # http://localhost:8787
```

## Selling flow

1. Customer tries the design with their names → gets a preview link by email.
2. They tap **Buy this design** → WhatsApp opens with their preview link.
3. After payment: `/admin/` → find the preview → **Make live** → choose the link (e.g. `ayesha-weds-hamza`).
4. In the editor, fill in their dates, venues, parents, message and RSVP number (JSON). Only what differs from the sample is needed.
5. Optional (guest list tier): add guests with seats and functions, and copy each guest's link.
6. Ever After: guest replies appear under **Replies** in the editor.

Edits are instant: every link already sent shows the new details.

## Adding a new theme

1. Create `public/themes/<name>/index.html`. It must include, in `<head>`:
   `<title>`, `<meta name="description">`, and `og:title`, `og:description`, `og:image`, `og:url` meta tags.
   And before its main script: `<script id="invite-data" type="application/json">null</script>`.
2. In the theme's script, keep sample content as `DEFAULTS`, then merge the injected data over it (copy the `merge` / `INJECTED` / `CONFIG` lines from Signature).
3. Add a 1200×630 `og.png` (the WhatsApp preview image).
   Put the theme's videos, posters and music in `public/themes/<name>/assets/`. In the config, refer to them as `assets/ceremony.mp4` etc.
4. Register it in `THEMES` at the top of `src/worker.js`.
5. Copy `public/templates/signature/` to `public/templates/<name>/`, change the text and `template: "<name>"` in its form script, and add a tile to `public/index.html`.

To bring in your own valima design: move its HTML into `public/themes/valima/index.html` and its images under `public/themes/valima/`, replace its hard-coded content object with `DEFAULTS` + merge as above, then follow steps 3–5.

## Config shape (what the editor saves)

```json
{
  "couple": { "bride": "Ayesha", "groom": "Hamza" },
  "parents": {
    "bride": { "line": "Daughter of", "names": "Mr. & Mrs. Tariq Mahmood" },
    "groom": { "line": "Son of", "names": "Mr. & Mrs. Imran Qureshi" }
  },
  "message": "With the blessings of Allah…",
  "rsvp": { "phone": "+92 300 1234567", "whatsapp": "923001234567" },
  "selectedEvents": ["baraat", "walima"],
  "events": {
    "baraat": { "start": "2026-12-12T20:00:00+05:00", "venue": "Royal Banquet", "address": "Shahrah-e-Faisal, Karachi" },
    "walima": { "start": "2026-12-13T19:00:00+05:00", "venue": "Topaz Marquee", "address": "Johar Town, Lahore" }
  }
}
```

## Free plan limits (as of Oct 2026)
Workers: 100,000 requests/day. D1: 500 MB per database (each invitation is a few KB). Resend: 3,000 emails/month, 100/day.

## Ever After notes
- Built from the Haris & Filza valima design: envelope with gold ripple, aisle walk-in (61 frames in `assets/walk/`), scratch card, countdown, framed card.
- The wax seal is `assets/seal-blank.png`; each couple's initials are drawn on it in the browser.
- Content the couple can change (via the admin editor JSON): `couple`, `fullNames`, `parents`, `hosts`, `request`, `place`, `events.<key>` (title, start, hours, venue, address, note, map), `timeline` (time, title, note, icon: arrive, rings, drinks, photo, dinner, cake, dance, car, heart), `details`, `travel`, `gifts`, `rsvp` (deadline, meals, askSong), `quote`, `hashtag`, `closing`, `music`.

## Couple panel

Every live invitation has a private panel at `/manage/<token>` where the couple can edit their names, dates, venues and message, and (on the **Invitation + Guest list** package) add guests, send personal links on WhatsApp, see who opened them, and read RSVP replies.

- Choose the package when you make an invitation live, or change it later in the admin editor's **Couple panel** box.
- Send the link with **Send to couple on WhatsApp**. **Make a new link** turns off the old one.
- Invitations that were live before this update get a link (Invitation package) the first time you open them in admin.
- Opens are not counted for link-preview bots or for `?check` previews from the panel.
- Timeline, "Good to know" and travel still edit through the admin JSON.

## Renamed designs

Old keys still work: `noor-mahal`, `jharokha` and `noor-mahal-2` open as Signature, `noor-mahal-3` as Resham (see `ALIASES` in `src/worker.js`). Old `/templates/...` and `/themes/...` links redirect to the new ones.
