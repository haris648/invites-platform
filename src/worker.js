/**
 * Invites platform — one Cloudflare Worker.
 *
 * Static files in /public (shop pages, themes, admin) are served by Cloudflare directly.
 * This Worker only runs for the dynamic routes:
 *
 *   POST /api/try                  save a try-on draft, email the preview link
 *   GET  /try/:id                  show a theme filled with that draft (preview mode)
 *   GET  /:slug                    a paid, live invitation
 *   GET  /:slug/:guest             the same invitation for one guest (name, seats, their events)
 *   POST /api/rsvp                 a guest's reply to a live invitation
 *   *    /api/admin/...            your admin panel's API (needs ADMIN_TOKEN)
 */

// Every theme you sell is registered here. `path` is its folder in /public/themes.
const THEMES = {
  "noor-mahal": {
    name: "Noor Mahal",
    path: "/themes/noor-mahal/",
    og: "/themes/noor-mahal/og.png",
    events: ["mehndi", "nikkah", "baraat", "walima"],
    titles: { mehndi: "Mehndi", nikkah: "Nikkah", baraat: "Baraat", walima: "Walima" },
    timeZone: "Asia/Karachi",
    rsvpOnPage: false,   // guests reply on WhatsApp
    shareMessage: "Assalam o Alaikum {guest}! With great joy, {couple} invite you to celebrate their wedding with them. Please open your invitation: {link}",
  },
  "ever-after": {
    name: "Ever After",
    path: "/themes/ever-after/",
    og: "/themes/ever-after/og.jpg",
    events: ["welcome", "ceremony", "reception", "brunch"],
    titles: { welcome: "Welcome Drinks", ceremony: "The Ceremony", reception: "The Reception", brunch: "Farewell Brunch" },
    timeZone: "Europe/London",
    rsvpOnPage: true,
    shareMessage: "Dear {guest}, {couple} would love you to join them as they celebrate their wedding. Your invitation is here: {link}",
  },
};
// Old theme keys that were renamed, so earlier previews keep working.
const ALIASES = { jharokha: "noor-mahal" };
const themeFor = (key) => THEMES[ALIASES[key] || key];

// Regular prices per region. Visitors are matched by the country Cloudflare detects; anyone not listed gets DEFAULT.
const PRICING = {
  DEFAULT: { currency: "USD", invitation: 100,  guestlist: 130 },
  AE:      { currency: "AED", invitation: 300,  guestlist: 400 },
  AU:      { currency: "AUD", invitation: 100,  guestlist: 130 },
  PK:      { currency: "PKR", invitation: 8000, guestlist: 10000 },
};
// Sale for every region. While it runs, the regular price is shown crossed out.
// To end it early or run a new one, change the date (or set percent to 0).
const SALE = { percent: 20, label: "Launch offer", ends: "2026-10-28T23:59:59+05:00" };

const RESERVED = new Set(["api", "try", "templates", "themes", "admin", "manage", "assets", "favicon.ico", "robots.txt", "404.html"]);
const TIERS = ["basic", "guests"];   // basic = Invitation, guests = Invitation + Guest list
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$/;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

    try {
      await ensureTables(env);
      if (url.pathname === "/api/try" && req.method === "POST") return await createDraft(req, env, ctx, url);
      if (url.pathname === "/api/rsvp" && req.method === "POST") return await saveRsvp(req, env);
      if (url.pathname === "/api/pricing" && req.method === "GET") return pricing(req, url);
      if (parts[0] === "api" && parts[1] === "admin") return await admin(req, env, url, parts.slice(2));
      if (parts[0] === "api" && parts[1] === "couple" && parts[2]) return await couple(req, env, url, parts[2], parts.slice(3));
      if (req.method === "GET" && parts[0] === "manage" && parts.length === 2) return await couplePage(env, url);
      if (req.method === "GET" && parts[0] === "try" && parts.length === 2) return await renderDraft(env, url, parts[1]);
      if (req.method === "GET" && parts.length >= 1 && parts.length <= 2 && !RESERVED.has(parts[0])) {
        return await renderInvitation(req, env, ctx, url, parts[0].toLowerCase(), parts[1]?.toLowerCase());
      }
    } catch (err) {
      console.error(err);
      return json({ error: "Something went wrong on our side. Please try again." }, 500);
    }
    const res = await env.ASSETS.fetch(req);
    return res.status === 404 ? notFound(env, url) : res;
  },
};

/* ---------------- try-on ---------------- */

async function createDraft(req, env, ctx, url) {
  const body = await req.json().catch(() => null);
  if (!body) return json({ error: "Send the form as JSON." }, 400);

  const theme = themeFor(body.template);
  const bride = clean(body.bride, 24);
  const groom = clean(body.groom, 24);
  const email = clean(body.email, 120).toLowerCase();
  const events = Array.isArray(body.events) ? [...new Set(body.events)].filter((e) => theme?.events.includes(e)) : [];

  if (!theme) return json({ error: "That design doesn't exist." }, 400);
  if (!bride || !groom) return json({ error: "Add both the bride's and the groom's name." }, 400);
  if (!EMAIL_RE.test(email)) return json({ error: "Enter a valid email so we can send your preview link." }, 400);
  if (!events.length) return json({ error: "Pick at least one function." }, 400);

  // Simple abuse guard: 10 previews per IP and 5 per email address per hour.
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  const since = Date.now() - 3600e3;
  const counts = await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM drafts WHERE ip = ?1 AND created_at > ?3) AS by_ip, (SELECT COUNT(*) FROM drafts WHERE email = ?2 AND created_at > ?3) AS by_email"
  ).bind(ip, email, since).first();
  if (counts.by_ip >= 10 || counts.by_email >= 5) {
    return json({ error: "You've made a lot of previews in the last hour. Please try again a little later." }, 429);
  }

  const id = randomId(10);
  const data = { couple: { bride, groom }, selectedEvents: events };
  await env.DB.prepare("INSERT INTO drafts (id, template, email, data, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, body.template, email, JSON.stringify(data), ip, Date.now())
    .run();

  const link = `${origin(env, url)}/try/${id}`;
  ctx.waitUntil(sendPreviewEmail(env, { email, bride, groom, themeName: theme.name, link }));
  return json({ id, url: `/try/${id}` });
}

async function renderDraft(env, url, id) {
  const draft = await env.DB.prepare("SELECT * FROM drafts WHERE id = ?").bind(id).first();
  const theme = draft && themeFor(draft.template);
  if (!theme) return notFound(env, url);

  const data = JSON.parse(draft.data);
  const { bride, groom } = data.couple;
  const config = { ...data, guest: null, preview: true, buyUrl: buyLink(env, theme.name, `${origin(env, url)}/try/${id}`) };
  return serveTheme(env, url, theme, config, {
    title: `${bride} & ${groom} · Invitation preview`,
    description: `Your ${theme.name} wedding invitation preview`,
  });
}

/* ---------------- live invitations ---------------- */

async function renderInvitation(req, env, ctx, url, slug, guestKey) {
  const inv = await env.DB.prepare("SELECT * FROM invitations WHERE slug = ? AND status = 'live'").bind(slug).first();
  const theme = inv && themeFor(inv.template);
  if (!theme) return notFound(env, url);

  const config = { guest: null, ...JSON.parse(inv.data), slug, guestKey: guestKey || null };
  let description = "You're invited";

  if (guestKey) {
    const guest = await env.DB.prepare("SELECT * FROM guests WHERE invitation_slug = ? AND key = ?").bind(slug, guestKey).first();
    if (!guest) return notFound(env, url);
    config.guest = { name: guest.name, seats: guest.seats || null };
    const allowed = guest.events ? JSON.parse(guest.events) : null;
    if (allowed?.length) config.selectedEvents = (config.selectedEvents || theme.events).filter((e) => allowed.includes(e));
    description = `${guest.name}, you're invited`;
    // Remember that this guest opened their invitation (ignore link-preview bots and the couple checking it)
    const ua = req.headers.get("user-agent") || "";
    if (!url.searchParams.has("check") && !/bot|crawler|spider|preview|whatsapp|facebookexternalhit|telegram|slack|discord|skype/i.test(ua)) {
      const now = Date.now();
      ctx.waitUntil(env.DB.prepare(
        "INSERT INTO guest_views (invitation_slug, key, first_at, last_at, views) VALUES (?, ?, ?, ?, 1) " +
        "ON CONFLICT(invitation_slug, key) DO UPDATE SET last_at = excluded.last_at, views = views + 1"
      ).bind(slug, guestKey, now, now).run().catch(() => {}));
    }
  }

  const c = config.couple || {};
  return serveTheme(env, url, theme, config, {
    title: c.bride && c.groom ? `${c.bride} & ${c.groom}` : "Wedding Invitation",
    description,
  });
}

/* ---------------- theme rendering ---------------- */

async function serveTheme(env, url, theme, config, meta) {
  const res = await env.ASSETS.fetch(new Request(new URL(theme.path, url.origin)));
  if (!res.ok) return notFound(env, url);

  // JSON inside <script> must never contain "<", or a name like "</script>" could break out.
  const safeJson = JSON.stringify(config).replace(/[<\u2028\u2029]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  const ogImage = new URL(theme.og, origin(env, url)).href;

  const out = new HTMLRewriter()
    // Themes load their images and music from relative paths like "assets/hero.jpg".
    // Previews and invitations live at other URLs, so point relative paths back at the theme folder.
    .on("head", { element: (el) => el.prepend(`<base href="${theme.path}">`, { html: true }) })
    .on("script#invite-data", { element: (el) => el.setInnerContent(safeJson, { html: true }) })
    .on("title", { element: (el) => el.setInnerContent(meta.title) })
    .on('meta[name="description"]', { element: (el) => el.setAttribute("content", meta.description) })
    .on('meta[property="og:title"]', { element: (el) => el.setAttribute("content", meta.title) })
    .on('meta[property="og:description"]', { element: (el) => el.setAttribute("content", meta.description) })
    .on('meta[property="og:image"]', { element: (el) => el.setAttribute("content", ogImage) })
    .on('meta[property="og:url"]', { element: (el) => el.setAttribute("content", url.href) })
    .transform(res);

  return new Response(out.body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
      "x-robots-tag": "noindex",
    },
  });
}

/* ---------------- admin API ---------------- */

async function admin(req, env, url, path) {
  const auth = req.headers.get("authorization") || "";
  if (!env.ADMIN_TOKEN || auth !== `Bearer ${env.ADMIN_TOKEN}`) return json({ error: "Wrong admin password." }, 401);

  const now = Date.now();
  const [resource, slug, sub, key] = path;

  // GET /api/admin/drafts
  if (resource === "drafts" && req.method === "GET") {
    const { results } = await env.DB.prepare("SELECT id, template, email, data, created_at FROM drafts ORDER BY created_at DESC LIMIT 100").all();
    return json({ drafts: results.map((d) => ({ ...d, data: JSON.parse(d.data) })) });
  }

  if (resource !== "invitations") return json({ error: "Unknown admin route." }, 404);

  // GET /api/admin/invitations
  if (!slug && req.method === "GET") {
    const { results } = await env.DB.prepare("SELECT slug, template, status, email, created_at, updated_at FROM invitations ORDER BY created_at DESC LIMIT 200").all();
    return json({ invitations: results });
  }

  // POST /api/admin/invitations  { slug, draft_id }  or  { slug, template, data }
  if (!slug && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const newSlug = clean(body.slug, 60).toLowerCase();
    if (!SLUG_RE.test(newSlug) || RESERVED.has(newSlug)) return json({ error: "Use 3–60 lowercase letters, numbers or dashes for the link, e.g. ayesha-weds-hamza." }, 400);

    let template = body.template, data = body.data, email = body.email || null, draftId = null;
    if (body.draft_id) {
      const draft = await env.DB.prepare("SELECT * FROM drafts WHERE id = ?").bind(body.draft_id).first();
      if (!draft) return json({ error: "No preview with that ID." }, 404);
      template = draft.template; data = JSON.parse(draft.data); email = draft.email; draftId = draft.id;
    }
    if (ALIASES[template]) template = ALIASES[template];
    if (!THEMES[template] || typeof data !== "object") return json({ error: "Give a draft_id, or a template and data." }, 400);

    const exists = await env.DB.prepare("SELECT 1 FROM invitations WHERE slug = ?").bind(newSlug).first();
    if (exists) return json({ error: "That link is already taken." }, 409);

    await env.DB.prepare("INSERT INTO invitations (slug, template, data, status, draft_id, email, created_at, updated_at) VALUES (?, ?, ?, 'live', ?, ?, ?, ?)")
      .bind(newSlug, template, JSON.stringify(data), draftId, email, now, now).run();
    const acc = await accessFor(env, newSlug, TIERS.includes(body.tier) ? body.tier : "basic");
    return json({ slug: newSlug, url: `${origin(env, url)}/${newSlug}`, manageUrl: `${origin(env, url)}/manage/${acc.token}`, tier: acc.tier }, 201);
  }

  const inv = await env.DB.prepare("SELECT * FROM invitations WHERE slug = ?").bind(slug).first();
  if (!inv) return json({ error: "No invitation with that link." }, 404);

  // GET /api/admin/invitations/:slug
  if (!sub && req.method === "GET") {
    const { results } = await env.DB.prepare("SELECT key, name, seats, events FROM guests WHERE invitation_slug = ? ORDER BY created_at").bind(slug).all();
    const rsvps = await env.DB.prepare("SELECT guest_key, name, attending, count, meals, dietary, song, message, created_at FROM rsvps WHERE invitation_slug = ? ORDER BY created_at DESC").bind(slug).all();
    return json({
      invitation: { ...inv, data: JSON.parse(inv.data) },
      access: await accessFor(env, slug).then((a) => ({ tier: a.tier, manageUrl: `${origin(env, url)}/manage/${a.token}` })),
      events: themeFor(inv.template)?.events || [],
      guests: results.map((g) => ({ ...g, events: g.events ? JSON.parse(g.events) : null })),
      rsvps: rsvps.results.map((r) => ({ ...r, meals: r.meals ? JSON.parse(r.meals) : [] })),
    });
  }

  // PUT /api/admin/invitations/:slug  { data?, status? }
  if (!sub && req.method === "PUT") {
    const body = await req.json().catch(() => ({}));
    const data = body.data !== undefined ? body.data : JSON.parse(inv.data);
    const status = body.status || inv.status;
    if (typeof data !== "object" || !["live", "hidden"].includes(status)) return json({ error: "Data must be an object and status live or hidden." }, 400);
    await env.DB.prepare("UPDATE invitations SET data = ?, status = ?, updated_at = ? WHERE slug = ?").bind(JSON.stringify(data), status, now, slug).run();
    return json({ ok: true });
  }

  // PUT /api/admin/invitations/:slug/access  { tier?, regenerate? }
  if (sub === "access" && req.method === "PUT") {
    const body = await req.json().catch(() => ({}));
    const acc = await accessFor(env, slug);
    const tier = TIERS.includes(body.tier) ? body.tier : acc.tier;
    const token = body.regenerate ? randomId(24) : acc.token;
    await env.DB.prepare("UPDATE invitation_access SET tier = ?, token = ? WHERE invitation_slug = ?").bind(tier, token, slug).run();
    return json({ tier, manageUrl: `${origin(env, url)}/manage/${token}` });
  }

  // POST /api/admin/invitations/:slug/guests  { name, key?, seats?, events? }
  if (sub === "guests" && !key && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const name = clean(body.name, 60);
    if (!name) return json({ error: "Add the guest's name." }, 400);
    const gKey = (clean(body.key, 40) || slugify(name)).toLowerCase();
    if (!SLUG_RE.test(gKey)) return json({ error: "Guest link must be 3+ lowercase letters, numbers or dashes." }, 400);
    const seats = Number.isInteger(+body.seats) && +body.seats > 0 ? +body.seats : null;
    const valid = themeFor(inv.template)?.events || [];
    const events = Array.isArray(body.events) ? body.events.filter((e) => valid.includes(e)) : [];
    try {
      await env.DB.prepare("INSERT INTO guests (invitation_slug, key, name, seats, events, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(slug, gKey, name, seats, events.length ? JSON.stringify(events) : null, now).run();
    } catch {
      return json({ error: "A guest with that link already exists." }, 409);
    }
    return json({ key: gKey, url: `${origin(env, url)}/${slug}/${gKey}` }, 201);
  }

  // DELETE /api/admin/invitations/:slug/guests/:key
  if (sub === "guests" && key && req.method === "DELETE") {
    await env.DB.prepare("DELETE FROM guests WHERE invitation_slug = ? AND key = ?").bind(slug, key).run();
    return json({ ok: true });
  }

  return json({ error: "Unknown admin route." }, 404);
}

/* ---------------- couple panel ---------------- */

// Newer tables are created on first use, so a deploy works even if schema.sql wasn't re-run.
let tablesReady = null;
function ensureTables(env) {
  if (!tablesReady) {
    tablesReady = env.DB.batch([
      env.DB.prepare("CREATE TABLE IF NOT EXISTS invitation_access (invitation_slug TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, tier TEXT NOT NULL DEFAULT 'basic', created_at INTEGER NOT NULL)"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS guest_views (invitation_slug TEXT NOT NULL, key TEXT NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, views INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (invitation_slug, key))"),
    ]).catch((err) => { tablesReady = null; throw err; });
  }
  return tablesReady;
}

// Each live invitation has a private panel link (/manage/<token>) and a tier.
async function accessFor(env, slug, tierIfNew = "basic") {
  let a = await env.DB.prepare("SELECT * FROM invitation_access WHERE invitation_slug = ?").bind(slug).first();
  if (!a) {
    a = { invitation_slug: slug, token: randomId(24), tier: tierIfNew, created_at: Date.now() };
    await env.DB.prepare("INSERT INTO invitation_access (invitation_slug, token, tier, created_at) VALUES (?, ?, ?, ?)")
      .bind(a.invitation_slug, a.token, a.tier, a.created_at).run();
  }
  return a;
}

async function couplePage(env, url) {
  const res = await env.ASSETS.fetch(new Request(new URL("/manage/", url.origin)));
  return new Response(res.body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", "referrer-policy": "no-referrer" } });
}

const MAX_GUESTS = 1500;
const GUEST_KEY_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

async function couple(req, env, url, token, path) {
  if (!/^[a-z0-9]{20,40}$/.test(token)) return json({ error: "This panel link isn't valid." }, 404);
  const acc = await env.DB.prepare("SELECT * FROM invitation_access WHERE token = ?").bind(token).first();
  if (!acc) return json({ error: "This panel link isn't valid any more. Please ask us for a new one." }, 404);
  const slug = acc.invitation_slug;
  const inv = await env.DB.prepare("SELECT * FROM invitations WHERE slug = ?").bind(slug).first();
  if (!inv) return json({ error: "This invitation no longer exists." }, 404);
  const theme = themeFor(inv.template);
  const data = JSON.parse(inv.data);
  const base = origin(env, url);
  const [section, key] = path;
  const guestsAllowed = acc.tier === "guests";

  // GET /api/couple/:token
  if (!section && req.method === "GET") {
    const [guests, views, rsvps] = await Promise.all([
      env.DB.prepare("SELECT key, name, seats, events, created_at FROM guests WHERE invitation_slug = ? ORDER BY created_at").bind(slug).all(),
      env.DB.prepare("SELECT key, first_at, views FROM guest_views WHERE invitation_slug = ?").bind(slug).all(),
      env.DB.prepare("SELECT guest_key, name, attending, count, meals, dietary, song, message, created_at FROM rsvps WHERE invitation_slug = ? ORDER BY created_at DESC").bind(slug).all(),
    ]);
    const seen = Object.fromEntries(views.results.map((v) => [v.key, v]));
    return json({
      slug, url: `${base}/${slug}`, status: inv.status, tier: acc.tier,
      theme: { key: ALIASES[inv.template] || inv.template, name: theme.name, events: theme.events, titles: theme.titles, timeZone: theme.timeZone, rsvpOnPage: theme.rsvpOnPage, shareMessage: theme.shareMessage },
      data,
      guests: guestsAllowed ? guests.results.map((g) => ({ ...g, events: g.events ? JSON.parse(g.events) : null, url: `${base}/${slug}/${g.key}`,
        openedAt: seen[g.key]?.first_at || null, views: seen[g.key]?.views || 0 })) : [],
      rsvps: rsvps.results.map((r) => ({ ...r, meals: r.meals ? JSON.parse(r.meals) : [] })),
      support: env.WHATSAPP_NUMBER || null,
    });
  }

  // PUT /api/couple/:token/details  — only the fields couples are allowed to change
  if (section === "details" && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ error: "Send the details as JSON." }, 400);
    const next = applyCoupleDetails(data, body, theme);
    if (!next.couple?.bride || !next.couple?.groom) return json({ error: "Both names are needed." }, 400);
    if (!next.selectedEvents?.length) return json({ error: "Keep at least one function on the invitation." }, 400);
    const text = JSON.stringify(next);
    if (text.length > 60000) return json({ error: "That's too much text. Please shorten some fields." }, 400);
    await env.DB.prepare("UPDATE invitations SET data = ?, updated_at = ? WHERE slug = ?").bind(text, Date.now(), slug).run();
    return json({ ok: true, data: next });
  }

  if (section !== "guests") return json({ error: "Unknown request." }, 404);
  if (!guestsAllowed) return json({ error: "Personal guest links come with the Invitation + Guest list package." }, 403);
  const eventsOf = (v) => (Array.isArray(v) ? [...new Set(v)].filter((e) => theme.events.includes(e)) : []);
  const seatsOf = (v) => { const n = parseInt(v, 10); return n > 0 && n < 100 ? n : null; };
  const count = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM guests WHERE invitation_slug = ?").bind(slug).first()).n;
  const uniqueKey = async (name) => {
    const stem = slugify(name).slice(0, 34) || "guest";
    for (let i = 0; i < 50; i++) {
      const k = i ? `${stem}-${i + 1}` : stem;
      const hit = await env.DB.prepare("SELECT 1 FROM guests WHERE invitation_slug = ? AND key = ?").bind(slug, k).first();
      if (!hit) return k;
    }
    return `${stem}-${randomId(4)}`;
  };

  // POST /api/couple/:token/guests  { name, seats, events }   or   { bulk: "Name, 3\nName, 2", seats, events }
  if (!key && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const rows = typeof body.bulk === "string"
      ? body.bulk.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
          const m = l.match(/^(.*?)[,\t;]\s*(\d{1,2})\s*$/);
          return m ? { name: m[1], seats: m[2] } : { name: l, seats: body.seats };
        })
      : [{ name: body.name, seats: body.seats }];
    const events = eventsOf(body.events);
    const already = await count();
    if (already + rows.length > MAX_GUESTS) return json({ error: `You can have up to ${MAX_GUESTS} guests.` }, 400);
    const added = [];
    for (const r of rows.slice(0, 500)) {
      const name = clean(r.name, 60);
      if (!name) continue;
      const k = await uniqueKey(name);
      await env.DB.prepare("INSERT INTO guests (invitation_slug, key, name, seats, events, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(slug, k, name, seatsOf(r.seats), events.length && events.length < theme.events.length ? JSON.stringify(events) : null, Date.now() + added.length).run();
      added.push({ key: k, name, url: `${base}/${slug}/${k}` });
    }
    if (!added.length) return json({ error: "Add at least one guest name." }, 400);
    return json({ added }, 201);
  }

  if (!key || !GUEST_KEY_RE.test(key)) return json({ error: "Unknown guest." }, 404);
  const guest = await env.DB.prepare("SELECT * FROM guests WHERE invitation_slug = ? AND key = ?").bind(slug, key).first();
  if (!guest) return json({ error: "That guest isn't on your list." }, 404);

  // PUT /api/couple/:token/guests/:key  { name?, seats?, events? }
  if (req.method === "PUT") {
    const body = await req.json().catch(() => ({}));
    const name = body.name !== undefined ? clean(body.name, 60) : guest.name;
    if (!name) return json({ error: "The guest needs a name." }, 400);
    const seats = body.seats !== undefined ? seatsOf(body.seats) : guest.seats;
    let events = guest.events;
    if (body.events !== undefined) { const ev = eventsOf(body.events); events = ev.length && ev.length < theme.events.length ? JSON.stringify(ev) : null; }
    await env.DB.prepare("UPDATE guests SET name = ?, seats = ?, events = ? WHERE invitation_slug = ? AND key = ?").bind(name, seats, events, slug, key).run();
    return json({ ok: true });
  }

  // DELETE /api/couple/:token/guests/:key
  if (req.method === "DELETE") {
    await env.DB.prepare("DELETE FROM guests WHERE invitation_slug = ? AND key = ?").bind(slug, key).run();
    await env.DB.prepare("DELETE FROM guest_views WHERE invitation_slug = ? AND key = ?").bind(slug, key).run();
    return json({ ok: true });
  }
  return json({ error: "Unknown request." }, 404);
}

// Copies only the fields a couple may edit from `body` onto the saved invitation data.
function applyCoupleDetails(data, body, theme) {
  const out = JSON.parse(JSON.stringify(data));
  const str = (v, max = 300) => (typeof v === "string" ? clean(v, max) : undefined);
  const set = (obj, k, v) => { if (v !== undefined) obj[k] = v; };
  if (body.couple) { out.couple = out.couple || {}; set(out.couple, "bride", str(body.couple.bride, 30)); set(out.couple, "groom", str(body.couple.groom, 30)); }
  if (body.fullNames) { out.fullNames = out.fullNames || {}; set(out.fullNames, "bride", str(body.fullNames.bride, 80)); set(out.fullNames, "groom", str(body.fullNames.groom, 80)); }
  if (body.parents) {
    out.parents = out.parents || {};
    for (const side of ["bride", "groom"]) {
      const v = body.parents[side];
      if (typeof v === "string") out.parents[side] = clean(v, 120);
      else if (v && typeof v === "object") out.parents[side] = { line: str(v.line, 40) || "", names: str(v.names, 120) || "" };
    }
  }
  for (const k of ["hosts", "request", "place", "hashtag", "closing", "opening"]) set(out, k, str(body[k], 200));
  set(out, "message", str(body.message, 900));
  set(out, "shareMessage", str(body.shareMessage, 600));
  if (typeof body.timeZone === "string" && /^[A-Za-z_]+\/[A-Za-z_\/-]+$/.test(body.timeZone)) out.timeZone = body.timeZone;
  if (Array.isArray(body.selectedEvents)) out.selectedEvents = [...new Set(body.selectedEvents)].filter((e) => theme.events.includes(e));
  if (body.events && typeof body.events === "object") {
    out.events = out.events || {};
    for (const k of theme.events) {
      const e = body.events[k]; if (!e || typeof e !== "object") continue;
      const t = (out.events[k] = out.events[k] || {});
      for (const f of ["title", "sub", "venue", "note"]) set(t, f, str(e[f], 160));
      set(t, "address", str(e.address, 240));
      if (typeof e.map === "string" && (e.map === "" || /^https:\/\//.test(e.map))) t.map = clean(e.map, 400);
      if (typeof e.start === "string" && !isNaN(Date.parse(e.start))) t.start = clean(e.start, 40);
      if (e.hours !== undefined) { const h = Number(e.hours); if (h > 0 && h <= 24) t.hours = h; }
    }
  }
  if (body.rsvp && typeof body.rsvp === "object") {
    out.rsvp = out.rsvp || {};
    if (typeof body.rsvp.deadline === "string" && (body.rsvp.deadline === "" || /^\d{4}-\d{2}-\d{2}$/.test(body.rsvp.deadline))) out.rsvp.deadline = body.rsvp.deadline;
    set(out.rsvp, "phone", str(body.rsvp.phone, 30));
    if (typeof body.rsvp.whatsapp === "string") out.rsvp.whatsapp = body.rsvp.whatsapp.replace(/\D/g, "").slice(0, 15);
    if (Array.isArray(body.rsvp.meals)) out.rsvp.meals = body.rsvp.meals.map((m) => clean(String(m), 60)).filter(Boolean).slice(0, 8);
    if (typeof body.rsvp.askSong === "boolean") out.rsvp.askSong = body.rsvp.askSong;
  }
  if (body.gifts && typeof body.gifts === "object") {
    out.gifts = out.gifts || {};
    set(out.gifts, "text", str(body.gifts.text, 500));
    set(out.gifts, "label", str(body.gifts.label, 40));
    if (typeof body.gifts.url === "string" && (body.gifts.url === "" || /^https:\/\//.test(body.gifts.url))) out.gifts.url = clean(body.gifts.url, 400);
  }
  return out;
}

/* ---------------- regional prices ---------------- */

function pricing(req, url) {
  // ?cc=AE lets you preview another region's prices
  const test = (url.searchParams.get("cc") || "").toUpperCase();
  const country = /^[A-Z]{2}$/.test(test) ? test : (req.cf && req.cf.country) || "";
  const p = PRICING[country] || PRICING.DEFAULT;
  const onSale = SALE.percent > 0 && Date.now() < Date.parse(SALE.ends);
  const tier = (regular) => (onSale ? { now: Math.round(regular * (100 - SALE.percent) / 100), was: regular } : { now: regular });
  return new Response(JSON.stringify({
    country, currency: p.currency,
    invitation: tier(p.invitation), guestlist: tier(p.guestlist),
    sale: onSale ? { percent: SALE.percent, label: SALE.label, ends: SALE.ends } : null,
  }), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" } });
}

/* ---------------- RSVP ---------------- */

async function saveRsvp(req, env) {
  const body = await req.json().catch(() => null);
  if (!body) return json({ error: "Send the reply as JSON." }, 400);
  const slug = clean(body.slug, 60).toLowerCase();
  const inv = slug && (await env.DB.prepare("SELECT slug FROM invitations WHERE slug = ? AND status = 'live'").bind(slug).first());
  if (!inv) return json({ error: "This invitation isn't accepting replies." }, 404);

  let guestKey = clean(body.guest, 40).toLowerCase() || null, max = 10;
  if (guestKey) {
    const g = await env.DB.prepare("SELECT seats FROM guests WHERE invitation_slug = ? AND key = ?").bind(slug, guestKey).first();
    if (!g) guestKey = null; else if (g.seats) max = g.seats;
  }
  const name = clean(body.name, 80);
  const attending = body.attending === "yes" ? "yes" : body.attending === "no" ? "no" : "";
  if (!name) return json({ error: "Please add your name." }, 400);
  if (!attending) return json({ error: "Please let the couple know if you can come." }, 400);
  const count = attending === "yes" ? Math.min(Math.max(parseInt(body.count, 10) || 1, 1), max) : 0;
  const meals = attending === "yes" && Array.isArray(body.meals) ? body.meals.slice(0, count).map((m) => clean(m, 60)) : [];

  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM rsvps WHERE ip = ? AND created_at > ?").bind(ip, Date.now() - 3600e3).first();
  if (recent.n >= 20) return json({ error: "Too many replies from this connection. Please try again later." }, 429);

  await env.DB.prepare("INSERT INTO rsvps (invitation_slug, guest_key, name, attending, count, meals, dietary, song, message, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(slug, guestKey, name, attending, count, JSON.stringify(meals), clean(body.dietary, 200), clean(body.song, 120), clean(body.message, 600), ip, Date.now())
    .run();
  return json({ ok: true }, 201);
}

/* ---------------- email ---------------- */

async function sendPreviewEmail(env, { email, bride, groom, themeName, link }) {
  if (!env.RESEND_API_KEY) {
    console.log(`[email skipped: no RESEND_API_KEY] ${email} → ${link}`);
    return;
  }
  const site = env.SITE_NAME || "The Invitary";
  const html = `<!doctype html><html><body style="margin:0;background:#0e2426;font-family:Georgia,serif;color:#f6eedf">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0e2426;padding:32px 16px"><tr><td align="center">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;border:1px solid #c8a04f;border-radius:18px;padding:32px 28px;text-align:center">
      <tr><td style="font-size:12px;letter-spacing:3px;color:#e6cd9f;text-transform:uppercase">${esc(site)}</td></tr>
      <tr><td style="padding:18px 0 6px;font-size:34px;font-style:italic">${esc(bride)} &amp; ${esc(groom)}</td></tr>
      <tr><td style="font-size:17px;line-height:1.5;color:#d9cfbd">Your ${esc(themeName)} invitation preview is ready. Open it any time from this link.</td></tr>
      <tr><td style="padding:26px 0 10px"><a href="${link}" style="display:inline-block;background:#c8a04f;color:#241806;text-decoration:none;padding:14px 28px;border-radius:999px;font-size:15px;letter-spacing:1px">Open my preview</a></td></tr>
      <tr><td style="font-size:13px;color:#a99f8c;word-break:break-all">${link}</td></tr>
    </table>
  </td></tr></table></body></html>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: env.FROM_EMAIL,
      to: [email],
      subject: `${bride} & ${groom}: your invitation preview`,
      html,
      text: `Your ${themeName} invitation preview is ready: ${link}`,
    }),
  });
  if (!res.ok) console.error("Resend error", res.status, await res.text());
}

/* ---------------- helpers ---------------- */

function buyLink(env, themeName, previewUrl) {
  if (!env.WHATSAPP_NUMBER) return null;
  const text = `Hi! I'd like to buy the ${themeName} invitation. My preview: ${previewUrl}`;
  return `https://wa.me/${env.WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`;
}

async function notFound(env, url) {
  const res = await env.ASSETS.fetch(new Request(new URL("/404.html", url.origin)));
  return new Response(res.body, { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
}

const origin = (env, url) => (env.SITE_URL || url.origin).replace(/\/$/, "");
const clean = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, "").trim().slice(0, max) : "");
const slugify = (s) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "guest";
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });

function randomId(len) {
  const abc = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => abc[b % abc.length]).join("");
}
