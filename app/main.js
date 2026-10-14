// Init.
// Classic script: shares one scope with the other files in app/, loaded in order by index.html.
"use strict";

/* ============================== init ============================== */
if (consumeSetupLink()) { ui.sheet = "settings"; showToast("Gemini key saved from setup link."); }
render();
initPersistence();
watchForUpdates();
