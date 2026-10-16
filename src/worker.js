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
 *   *    /api/admin/...            your admin panel's API (needs ADMIN_TOKEN)
 */

// Every theme you sell is registered here. `path` is its folder in /public/themes.
const THEMES = {
  jharokha: {
    name: "Jharokha",
    path: "/themes/jharokha/",
    og: "/themes/jharokha/og.png",
    events: ["mehndi", "nikkah", "baraat", "walima"],
  },
};

const RESERVED = new Set(["api", "try", "templates", "themes", "admin", "assets", "favicon.ico", "robots.txt", "404.html"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$/;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

    try {
      if (url.pathname === "/api/try" && req.method === "POST") return await createDraft(req, env, ctx, url);
      if (parts[0] === "api" && parts[1] === "admin") return await admin(req, env, url, parts.slice(2));
      if (req.method === "GET" && parts[0] === "try" && parts.length === 2) return await renderDraft(env, url, parts[1]);
      if (req.method === "GET" && parts.length >= 1 && parts.length <= 2 && !RESERVED.has(parts[0])) {
        return await renderInvitation(env, url, parts[0].toLowerCase(), parts[1]?.toLowerCase());
      }
    } catch (err) {
      console.error(err);
      return json({ error: "Something went wrong on our side. Please try again." }, 500);
    }
    return env.ASSETS.fetch(req);
  },
};

/* ---------------- try-on ---------------- */

async function createDraft(req, env, ctx, url) {
  const body = await req.json().catch(() => null);
  if (!body) return json({ error: "Send the form as JSON." }, 400);

  const theme = THEMES[body.template];
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
  const theme = draft && THEMES[draft.template];
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

async function renderInvitation(env, url, slug, guestKey) {
  const inv = await env.DB.prepare("SELECT * FROM invitations WHERE slug = ? AND status = 'live'").bind(slug).first();
  const theme = inv && THEMES[inv.template];
  if (!theme) return notFound(env, url);

  const config = { guest: null, ...JSON.parse(inv.data) };
  let description = "You're invited";

  if (guestKey) {
    const guest = await env.DB.prepare("SELECT * FROM guests WHERE invitation_slug = ? AND key = ?").bind(slug, guestKey).first();
    if (!guest) return notFound(env, url);
    config.guest = { name: guest.name, seats: guest.seats || null };
    const allowed = guest.events ? JSON.parse(guest.events) : null;
    if (allowed?.length) config.selectedEvents = (config.selectedEvents || theme.events).filter((e) => allowed.includes(e));
    description = `${guest.name}, you're invited`;
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
    if (!THEMES[template] || typeof data !== "object") return json({ error: "Give a draft_id, or a template and data." }, 400);

    const exists = await env.DB.prepare("SELECT 1 FROM invitations WHERE slug = ?").bind(newSlug).first();
    if (exists) return json({ error: "That link is already taken." }, 409);

    await env.DB.prepare("INSERT INTO invitations (slug, template, data, status, draft_id, email, created_at, updated_at) VALUES (?, ?, ?, 'live', ?, ?, ?, ?)")
      .bind(newSlug, template, JSON.stringify(data), draftId, email, now, now).run();
    return json({ slug: newSlug, url: `${origin(env, url)}/${newSlug}` }, 201);
  }

  const inv = await env.DB.prepare("SELECT * FROM invitations WHERE slug = ?").bind(slug).first();
  if (!inv) return json({ error: "No invitation with that link." }, 404);

  // GET /api/admin/invitations/:slug
  if (!sub && req.method === "GET") {
    const { results } = await env.DB.prepare("SELECT key, name, seats, events FROM guests WHERE invitation_slug = ? ORDER BY created_at").bind(slug).all();
    return json({
      invitation: { ...inv, data: JSON.parse(inv.data) },
      events: THEMES[inv.template]?.events || [],
      guests: results.map((g) => ({ ...g, events: g.events ? JSON.parse(g.events) : null })),
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

  // POST /api/admin/invitations/:slug/guests  { name, key?, seats?, events? }
  if (sub === "guests" && !key && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const name = clean(body.name, 60);
    if (!name) return json({ error: "Add the guest's name." }, 400);
    const gKey = (clean(body.key, 40) || slugify(name)).toLowerCase();
    if (!SLUG_RE.test(gKey)) return json({ error: "Guest link must be 3+ lowercase letters, numbers or dashes." }, 400);
    const seats = Number.isInteger(+body.seats) && +body.seats > 0 ? +body.seats : null;
    const valid = THEMES[inv.template]?.events || [];
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

/* ---------------- email ---------------- */

async function sendPreviewEmail(env, { email, bride, groom, themeName, link }) {
  if (!env.RESEND_API_KEY) {
    console.log(`[email skipped: no RESEND_API_KEY] ${email} → ${link}`);
    return;
  }
  const site = env.SITE_NAME || "Invites";
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
