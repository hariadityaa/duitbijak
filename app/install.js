// Install prompt and update banner.
// Classic script: shares one scope with the other files in app/, loaded in order by index.html.
"use strict";

/* ============================== install & updates ============================== */
// Chrome's menu install can say "already installed" when another app on hurrymeow.github.io
// is installed. The page prompt checks this app's scope correctly, so offer it in the page.
const INSTALL_DECLINED = "duitbijak.installDeclined";
const pwa = { installEvent: null, installDeclined: false, updateReady: false };
try { pwa.installDeclined = localStorage.getItem(INSTALL_DECLINED) === "1"; } catch (e) {}
function isStandalone() { return matchMedia("(display-mode: standalone)").matches || navigator.standalone === true; }

window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); pwa.installEvent = e; render(); });
window.addEventListener("appinstalled", () => { pwa.installEvent = null; render(); });

// A new deploy ships a new sw.js. It installs, takes over at once and fires
// controllerchange. The open page still runs the old code, so offer a reload.
// The installed app can sit in the background for days, so check on return.
const UPDATE_CHECK_MS = 30 * 60 * 1000;
function watchForUpdates() {
  if (!("serviceWorker" in navigator)) return;
  const sw = navigator.serviceWorker;
  // The first install also fires controllerchange. That is not an update.
  let hadController = !!sw.controller;
  sw.addEventListener("controllerchange", () => {
    if (hadController) { pwa.updateReady = true; render(); }
    hadController = true;
  });
  sw.register("sw.js").then(reg => {
    const check = () => reg.update().catch(() => {});
    document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
    setInterval(check, UPDATE_CHECK_MS);
  }).catch(() => {});
}
