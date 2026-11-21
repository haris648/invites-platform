/* Google Analytics 4 for the shop pages (homepage and design pages).
   Not loaded on couples' invitations or previews: guests' visits aren't shop traffic, and those pages hold private names.

   Events sent:
     view_design      a design page is opened                  { design }
     try_preview      a free preview is made with their names  { design }
     whatsapp_click   any WhatsApp button or link is tapped    { link_text, page }   <- your leads
*/
(function () {
  var ID = "G-VDKZ1M23L3";
  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag("js", new Date());
  gtag("config", ID);
  var s = document.createElement("script");
  s.async = true; s.src = "https://www.googletagmanager.com/gtag/js?id=" + ID;
  document.head.appendChild(s);

  // design pages live at /templates/<design>/
  var m = location.pathname.match(/^\/templates\/([a-z0-9-]+)/);
  if (m) gtag("event", "view_design", { design: m[1] });

  // WhatsApp taps, wherever they are on the page
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a[href]");
    if (!a || !/wa\.me|whatsapp\.com/.test(a.href)) return;
    gtag("event", "whatsapp_click", { link_text: (a.textContent || "").trim().slice(0, 60), page: location.pathname, design: m ? m[1] : "" });
  }, true);

  // a preview made with their names: the "Try it free" form posts to /api/try
  if (window.fetch) {
    var f = window.fetch;
    window.fetch = function (url, opts) {
      var p = f.apply(this, arguments);
      if (String(url).indexOf("/api/try") > -1 && opts && opts.method === "POST") {
        var design = ""; try { design = JSON.parse(opts.body).template || ""; } catch (err) {}
        p.then(function (res) { if (res.ok) gtag("event", "try_preview", { design: design, transport_type: "beacon" }); }).catch(function () {});
      }
      return p;
    };
  }
})();
