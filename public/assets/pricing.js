/* Shows prices for the visitor's region, and the sale banner while a sale runs.
   Amounts, regions and the sale date live in src/worker.js (PRICING and SALE). */
(function () {
  var els = document.querySelectorAll("[data-price],[data-was]");
  if (!els.length) return;
  els.forEach(function (el) { el.style.transition = "opacity .25s"; el.style.opacity = "0"; });
  var cc = new URLSearchParams(location.search).get("cc");
  fetch("/api/pricing" + (cc ? "?cc=" + encodeURIComponent(cc) : ""))
    .then(function (r) { return r.json(); })
    .then(function (p) {
      var locale = p.currency === "PKR" ? "en-PK" : "en-US";
      var fmt = new Intl.NumberFormat(locale, { style: "currency", currency: p.currency, maximumFractionDigits: 0 });
      document.querySelectorAll("[data-price]").forEach(function (el) {
        var t = p[el.getAttribute("data-price")]; if (t) el.textContent = fmt.format(t.now);
      });
      document.querySelectorAll("[data-was]").forEach(function (el) {
        var t = p[el.getAttribute("data-was")];
        if (t && t.was) { el.textContent = fmt.format(t.was); el.hidden = false; } else el.hidden = true;
      });
      document.querySelectorAll("[data-sale]").forEach(function (el) {
        if (!p.sale) { el.hidden = true; return; }
        var days = Math.floor((Date.parse(p.sale.ends) - Date.now()) / 864e5);
        var ends = new Date(p.sale.ends).toLocaleDateString("en-GB", { day: "numeric", month: "long" });
        el.textContent = p.sale.label + ": " + p.sale.percent + "% off every design · " +
          (days < 1 ? "ends today" : days === 1 ? "1 day left" : days + " days left, until " + ends);
        el.hidden = false;
      });
    })
    .catch(function () {})
    .then(function () { els.forEach(function (el) { el.style.opacity = "1"; }); });
})();
