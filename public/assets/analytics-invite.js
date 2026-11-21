/* Google Analytics for live invitations (our own cards and customers' cards on themes that include this file). Same GA property as the shop, kept apart by
   page_type = "invitation", so shop reports stay clean: filter or compare on page_type, or on the invitation name.

   Privacy: guests' personal links (/haris-ka-valima/khala-nasreen) are reported as the invitation's main link
   (/haris-ka-valima) with guest_link = "yes", so guest names are never sent to Google.

   Events sent:
     invitation_open   the card is opened                          { invitation, guest_link }
     rsvp_click        a WhatsApp RSVP button is tapped            { invitation, guest_link }
     directions_click  a map / location button is tapped           { invitation, guest_link }
     calendar_click    "add to calendar" is tapped                 { invitation, guest_link }
     rsvp_submit       the on-page RSVP form is sent (Lulua)       { invitation, guest_link }
*/
(function () {
  var data = null; try { data = JSON.parse(document.getElementById("invite-data").textContent); } catch (e) {}
  if (!data || !data.slug) return;           // only on live invitations, not when the theme file is opened directly
  if (/[?&]check\b/.test(location.search)) return;   // you checking a link with ?check isn't a guest visit (same rule as the admin stats)

  var ID = "G-VDKZ1M23L3";
  var inv = data.slug, guest = data.guestKey ? "yes" : "no";
  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag("js", new Date());
  gtag("config", ID, {
    page_location: location.origin + "/" + inv,
    page_title: document.title,
    page_type: "invitation",
    invitation: inv,
    guest_link: guest,
  });
  var s = document.createElement("script");
  s.async = true; s.src = "https://www.googletagmanager.com/gtag/js?id=" + ID;
  document.head.appendChild(s);

  var p = { invitation: inv, guest_link: guest, page_type: "invitation" };
  var sent = {};
  function once(name) { if (!sent[name]) { sent[name] = 1; gtag("event", name, p); } }

  document.addEventListener("click", function (e) {
    // opening the card: the envelope (Valima) or the gate (Nikah)
    if (e.target.closest && e.target.closest("#envelope, #gate")) once("invitation_open");
    var a = e.target.closest && e.target.closest("a[href]");
    if (!a) return;
    var h = a.href;
    if (/wa\.me|whatsapp\.com/.test(h)) gtag("event", "rsvp_click", p);
    else if (/maps\.app\.goo\.gl|google\.[a-z.]+\/maps|maps\.google/.test(h)) gtag("event", "directions_click", p);
    else if (/calendar\.google|^data:text\/calendar/.test(h) || a.hasAttribute("download")) gtag("event", "calendar_click", p);
  }, true);
  // themes with an on-page RSVP form (e.g. Lulua): a reply sent
  document.addEventListener("submit", function (e) { if (e.target && e.target.id === "rForm") gtag("event", "rsvp_submit", p); }, true);
  document.addEventListener("keydown", function (e) {
    if ((e.key === "Enter" || e.key === " ") && e.target.closest && e.target.closest("#envelope, #gate")) once("invitation_open");
  }, true);
})();
