# Invites platform

Digital wedding invitation shop on Cloudflare (free plan): shop pages, "try with your names" previews, emailed preview links, live invitations, and per-guest links.

## How it works

- `public/` is plain HTML, served directly by Cloudflare: the shop (`/`, `/templates/<theme>/`), the themes (`/themes/<theme>/`) and your admin panel (`/admin/`).
- `src/worker.js` handles the dynamic routes. It fetches a theme file and fills in the customer's settings before sending it, so one theme file serves every customer and nothing is ever rebuilt.
- `schema.sql` is the database: `drafts` (try-ons), `invitations` (paid, live) and `guests`.

| URL | What it shows |
|---|---|
| `/templates/jharokha/` | Shop page with price, live sample and the try-on form |
| `/try/<id>` | A customer's preview with their names and functions |
| `/<slug>` | A paid invitation, e.g. `/ayesha-weds-hamza` |
| `/<slug>/<guest>` | The same invitation for one guest: greeted by name, their seats, only their functions |
| `/admin/` | Previews, make-live, edit content, guest links |

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

Edits are instant: every link already sent shows the new details.

## Adding a new theme

1. Create `public/themes/<name>/index.html`. It must include, in `<head>`:
   `<title>`, `<meta name="description">`, and `og:title`, `og:description`, `og:image`, `og:url` meta tags.
   And before its main script: `<script id="invite-data" type="application/json">null</script>`.
2. In the theme's script, keep sample content as `DEFAULTS`, then merge the injected data over it (copy the `merge` / `INJECTED` / `CONFIG` lines from Jharokha).
3. Add a 1200×630 `og.png` (the WhatsApp preview image).
4. Register it in `THEMES` at the top of `src/worker.js`.
5. Copy `public/templates/jharokha/` to `public/templates/<name>/`, change the text and `template: "<name>"` in its form script, and add a tile to `public/index.html`.

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
