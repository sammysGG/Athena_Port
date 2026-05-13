(function () {
  "use strict";
  var el = document.getElementById("utc-clock");
  if (!el) return;
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function tick() {
    var d = new Date();
    el.textContent =
      pad(d.getUTCHours()) + ":" +
      pad(d.getUTCMinutes()) + ":" +
      pad(d.getUTCSeconds()) + " UTC";
  }
  tick();
  setInterval(tick, 1000);
})();
