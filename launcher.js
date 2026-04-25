/* ============================================================
   PART 3 — IndexedDB + Settings System
   ============================================================ */

const DB_NAME = "html_game_launcher_v2";
const DB_VERSION = 1;

let db = null;

/* ------------------------------
   Open / Upgrade Database
------------------------------ */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      if (!db.objectStoreNames.contains("games_meta")) {
        db.createObjectStore("games_meta", { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains("games_html")) {
        db.createObjectStore("games_html", { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }
    };

    req.onsuccess = () => {
      db = req.result;
      resolve(db);
    };

    req.onerror = () => reject(req.error);
  });
}

// Mute the entire launcher site
try {
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const gain = audioCtx.createGain();
  gain.gain.value = 0; // mute everything
  gain.connect(audioCtx.destination);
} catch (e) {}


/* ------------------------------
   Transaction Helper
------------------------------ */
function tx(store, mode = "readonly") {
  return db.transaction(store, mode).objectStore(store);
}

/* ============================================================
   SETTINGS SYSTEM
   ============================================================ */

/* ------------------------------
   Load settings from DB
------------------------------ */
async function loadSettings() {
  const store = tx("settings");

  const themeReq = store.get("theme");
  const accentReq = store.get("accent");

  return new Promise((resolve) => {
    let theme = "dark";
    let accent = "#2385ff";
    let done = 0;

    themeReq.onsuccess = () => {
      if (themeReq.result) theme = themeReq.result.value;
      if (++done === 2) resolve({ theme, accent });
    };

    accentReq.onsuccess = () => {
      if (accentReq.result) accent = accentReq.result.value;
      if (++done === 2) resolve({ theme, accent });
    };
  });
}

/* ------------------------------
   Save a setting
------------------------------ */
function saveSetting(key, value) {
  const store = tx("settings", "readwrite");
  store.put({ key, value });
}

/* ------------------------------
   Apply theme + accent
------------------------------ */
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  document.getElementById("themeToggleBtn").textContent =
    theme === "dark" ? "Dark" : "Light";
}

function applyAccent(color) {
  document.documentElement.style.setProperty("--accent", color);
  document.getElementById("accentPicker").value = color;
}

/* ============================================================
   SETTINGS EXPORT / IMPORT
   ============================================================ */

/* ------------------------------
   Export settings.txt
------------------------------ */
async function exportSettingsTxt() {
  const { theme, accent } = await loadSettings();
  const content = `theme=${theme}\naccent=${accent}\n`;

  const blob = new Blob([content], { type: "text/plain" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = "settings.txt";
  document.body.appendChild(a);
  a.click();
  a.remove();

  URL.revokeObjectURL(url);
}

/* ------------------------------
   Import settings.txt
------------------------------ */
async function importSettingsTxt(file) {
  const text = await file.text();
  const lines = text.split(/\r?\n/);

  let theme = null;
  let accent = null;

  for (const line of lines) {
    const [k, v] = line.split("=");
    if (!k || !v) continue;

    if (k.trim() === "theme") theme = v.trim();
    if (k.trim() === "accent") accent = v.trim();
  }

  if (theme === "dark" || theme === "light") {
    applyTheme(theme);
    saveSetting("theme", theme);
  }

  if (accent && /^#?[0-9a-fA-F]{6}$/.test(accent)) {
    if (!accent.startsWith("#")) accent = "#" + accent;
    applyAccent(accent);
    saveSetting("accent", accent);
  }
}
/* ============================================================
   PART 4 — Game Import + Folder Import + Name Cleaning (FIXED)
   ============================================================ */

let gamesMeta = [];
let favoritesSet = new Set();
let recentIds = [];
let editMode = false;
let pendingFileForMeta = null;

/* ============================================================
   NAME CLEANING SYSTEM
   ============================================================ */

function cleanDisplayName(name) {
  let n = name.trim();
  n = n.replace(/^cl[\s\-_]+/i, "");
  n = n.replace(/\.html?$/i, "");
  return n.trim();
}

function makeIdFromName(name) {
  return cleanDisplayName(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/* ============================================================
   LOAD ALL GAMES META
   ============================================================ */

async function loadAllGamesMeta() {
  const store = tx("games_meta");
  return new Promise((resolve) => {
    const req = store.getAll();
    req.onsuccess = () => {
      gamesMeta = req.result.sort((a, b) =>
        (a.title || a.id).localeCompare(b.title || b.id)
      );

      favoritesSet = new Set(gamesMeta.filter(g => g.favorite).map(g => g.id));

      recentIds = gamesMeta
        .filter(g => g.lastPlayed)
        .sort((a, b) => b.lastPlayed - a.lastPlayed)
        .map(g => g.id)
        .slice(0, 50);

      resolve();
    };
  });
}

/* ============================================================
   SAVE GAME META + HTML
   ============================================================ */

async function saveGame(file, metaOverrides = null) {
  const rawName = file.name;
  const displayName = cleanDisplayName(rawName);
  const id = makeIdFromName(displayName);

  const html = await file.text();

  const meta = {
    id,
    title: displayName,
    tags: [],
    notes: "",
    favorite: false,
    lastPlayed: 0,
    ...metaOverrides
  };

  const metaStore = tx("games_meta", "readwrite");
  const htmlStore = tx("games_html", "readwrite");

  metaStore.put(meta);
  htmlStore.put({ id, html });

  await loadAllGamesMeta();
}

/* ============================================================
   QUICK ADD GAME
   ============================================================ */

async function quickAddGame(file) {
  await saveGame(file);
  renderGames();
}

/* ============================================================
   METADATA ADD GAME
   ============================================================ */

async function metaAddGame(file) {
  const rawName = file.name;
  const displayName = cleanDisplayName(rawName);
  const id = makeIdFromName(displayName);

  const titleInput = document.getElementById("metaTitleInput").value.trim();
  const tagsInput = document.getElementById("metaTagsInput").value.trim();
  const notesInput = document.getElementById("metaNotesInput").value.trim();

  const tags = tagsInput
    ? tagsInput.split(",").map(t => t.trim()).filter(Boolean)
    : [];

  const metaOverrides = {
    id,
    title: titleInput || displayName,
    tags,
    notes: notesInput
  };

  await saveGame(file, metaOverrides);
  renderGames();
}

/* ============================================================
   FOLDER IMPORT (RECURSIVE)
   ============================================================ */

async function importFolderRecursive(dirHandle) {
  for await (const entry of dirHandle.values()) {
    if (entry.kind === "file" && entry.name.toLowerCase().endsWith(".html")) {
      const file = await entry.getFile();
      await quickAddGame(file);
    }

    if (entry.kind === "directory") {
      await importFolderRecursive(entry);
    }
  }
}

function setupBigViewButton() {
  const bottomBar = document.querySelector(".bottombar");

  const btn = document.createElement("button");
  btn.className = "btn secondary";
  btn.textContent = "⤢"; // expand icon

  btn.onclick = toggleBigView;

  bottomBar.appendChild(btn);
}


function toggleBigView() {
  const wrapper = document.querySelector(".frame-wrapper");

  if (!wrapper.classList.contains("bigview")) {
    wrapper.classList.add("bigview");
  } else {
    wrapper.classList.remove("bigview");
  }
}

document.getElementById("bigviewClose").onclick = () => {
  document.querySelector(".frame-wrapper").classList.remove("bigview");
};

/* ============================================================
   UI HOOKS FOR ADD GAME / ADD FOLDER
   ============================================================ */

function setupImportButtons() {
  document.getElementById("addGameBtn").onclick = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".html,text/html";

    input.onchange = () => {
      const file = input.files[0];
      if (!file) return;

      pendingFileForMeta = file;
      document.getElementById("modeModalBackdrop").style.display = "flex";
    };

    input.click();
  };

  document.getElementById("addFolderBtn").onclick = async () => {
    try {
      const dir = await window.showDirectoryPicker();
      await importFolderRecursive(dir);
      renderGames();
    } catch (err) {
      console.log("Folder import cancelled:", err);
    }
  };
}

/* ============================================================
   MODE SELECT MODAL
   ============================================================ */

function setupModeModal() {
  document.getElementById("modeCancelBtn").onclick = () => {
    document.getElementById("modeModalBackdrop").style.display = "none";
    pendingFileForMeta = null;
  };

  document.getElementById("modeQuickBtn").onclick = async () => {
    const file = pendingFileForMeta;
    document.getElementById("modeModalBackdrop").style.display = "none";
    if (file) await quickAddGame(file);
    pendingFileForMeta = null;
  };

  document.getElementById("modeMetaBtn").onclick = () => {
    document.getElementById("modeModalBackdrop").style.display = "none";
    document.getElementById("metaModalBackdrop").style.display = "flex";
  };
}

/* ============================================================
   METADATA EDITOR MODAL (Cancel only)
   ============================================================ */

function setupMetaModal() {
  document.getElementById("metaCancelBtn").onclick = () => {
    document.getElementById("metaModalBackdrop").style.display = "none";
    pendingFileForMeta = null;
    editingGameId = null;
  };
}


/* ============================================================
   PART 5 — Edit Mode + Metadata Editing (FIXED)
   ============================================================ */

let editingGameId = null;

/* ============================================================
   RENDER GAME LIST
   ============================================================ */

function renderGames(view = "all") {
  const list = document.getElementById("gameList");
  list.innerHTML = "";

  let filtered = [...gamesMeta];

  if (view === "favorites") filtered = filtered.filter(g => g.favorite);
  if (view === "recent")
    filtered = filtered
      .filter(g => recentIds.includes(g.id))
      .sort((a, b) => b.lastPlayed - a.lastPlayed);

  const search = document.getElementById("search").value.toLowerCase();
  if (search) filtered = filtered.filter(g => g.title.toLowerCase().includes(search));

  for (const g of filtered) {
    const div = document.createElement("div");
    div.className = "game";
    div.dataset.id = g.id;

    const icon = document.createElement("div");
    icon.className = "icon";
    icon.textContent = g.title[0]?.toUpperCase() || "?";

    const title = document.createElement("div");
    title.className = "game-title";
    title.textContent = g.title;

    const fav = document.createElement("div");
    fav.className = "fav";
    fav.textContent = g.favorite ? "⭐" : "☆";
    fav.onclick = (e) => {
      e.stopPropagation();
      toggleFavorite(g.id);
    };

    div.appendChild(icon);
    div.appendChild(title);
    div.appendChild(fav);

    div.onclick = () => {
      if (editMode) openMetadataEditor(g.id);
      else launchGame(g.id);
    };

    list.appendChild(div);
  }
}

/* ============================================================
   FAVORITE TOGGLE (FIXED)
   ============================================================ */

function toggleFavorite(id) {
  const store = tx("games_meta", "readwrite");
  const req = store.get(id);

  req.onsuccess = () => {
    const meta = req.result;
    meta.favorite = !meta.favorite;
    store.put(meta);

    // Refresh UI instantly
    loadAllGamesMeta().then(renderGames);
  };
}


/* ============================================================
   LAUNCH GAME
   ============================================================ */

async function launchGame(id) {
  const htmlStore = tx("games_html");
  const metaStore = tx("games_meta", "readwrite");

  const htmlReq = htmlStore.get(id);
  const metaReq = metaStore.get(id);

  htmlReq.onsuccess = () => {
    const html = htmlReq.result?.html;
    if (!html) return;

    // Load into preview iframe
    const frame = document.getElementById("gameFrame");
    frame.srcdoc = html;
// Force mute preview audio
frame.onload = () => {
  try {
    const win = frame.contentWindow;

    // 1. Mute WebAudio API
    if (win.AudioContext) {
      const AC = win.AudioContext;
      win.AudioContext = function(...args) {
        const ctx = new AC(...args);
        const gain = ctx.createGain();
        gain.gain.value = 0; // mute
        gain.connect(ctx.destination);
        ctx.destination = gain;
        return ctx;
      };
    }

    // 2. Mute <audio> elements
    const doc = frame.contentDocument;
    const style = doc.createElement("style");
    style.textContent = `
      audio, video {
        volume: 0 !important;
        pointer-events: none !important;
      }
    `;
    doc.head.appendChild(style);

    // 3. Mute HTMLAudioElement.play()
    if (win.HTMLAudioElement) {
      win.HTMLAudioElement.prototype.play = function() {
        this.volume = 0;
        return Promise.resolve();
      };
    }

    // 4. Mute Howler.js if the game uses it
    Object.defineProperty(win, "Howler", {
      set(v) {
        try { v.volume(0); } catch(e) {}
      }
    });

  } catch (e) {
    console.warn("Mute failed:", e);
  }
};


    // Update label
    document.getElementById("currentGameLabel").textContent =
      gamesMeta.find(g => g.id === id)?.title || "Unknown Game";

    // Hide placeholder
    document.getElementById("placeholder").style.display = "none";
    frame.style.display = "block";
  };

  metaReq.onsuccess = () => {
    const meta = metaReq.result;
    meta.lastPlayed = Date.now();
    metaStore.put(meta);

    loadAllGamesMeta().then(renderGames);
  };
}


/* ============================================================
   EDIT MODE TOGGLE
   ============================================================ */

function setupEditMode() {
  const btn = document.getElementById("editModeBtn");
  btn.onclick = () => {
    editMode = !editMode;
    btn.textContent = editMode ? "ON" : "OFF";
  };
}

/* ============================================================
   OPEN METADATA EDITOR
   ============================================================ */

function openMetadataEditor(id) {
  editingGameId = id;

  const meta = gamesMeta.find(g => g.id === id);
  if (!meta) return;

  document.getElementById("metaTitleInput").value = meta.title;
  document.getElementById("metaTagsInput").value = meta.tags.join(", ");
  document.getElementById("metaNotesInput").value = meta.notes || "";

  document.getElementById("metaModalBackdrop").style.display = "flex";
}

/* ============================================================
   UNIFIED METADATA SAVE HANDLER (FIXED)
   ============================================================ */

document.getElementById("metaSaveBtn").onclick = async () => {

  // CASE 1 — Adding a new game
  if (pendingFileForMeta) {
    await metaAddGame(pendingFileForMeta);
    pendingFileForMeta = null;
    document.getElementById("metaModalBackdrop").style.display = "none";
    return;
  }

  // CASE 2 — Editing an existing game
  if (!editingGameId) return;

  const store = tx("games_meta", "readwrite");
  const req = store.get(editingGameId);

  req.onsuccess = async () => {
    const meta = req.result;

    const newTitle = cleanDisplayName(
      document.getElementById("metaTitleInput").value.trim()
    );

    const newId = makeIdFromName(newTitle);

    const tags = document
      .getElementById("metaTagsInput")
      .value.split(",")
      .map(t => t.trim())
      .filter(Boolean);

    meta.title = newTitle;
    meta.tags = tags;
    meta.notes = document.getElementById("metaNotesInput").value.trim();

    // If ID changed, migrate HTML + meta
    if (newId !== editingGameId) {
      const htmlStore = tx("games_html", "readwrite");
      const htmlReq = htmlStore.get(editingGameId);

      htmlReq.onsuccess = () => {
        const htmlData = htmlReq.result;
        if (htmlData) {
          htmlStore.delete(editingGameId);
          htmlStore.put({ id: newId, html: htmlData.html });
        }
      };

      store.delete(editingGameId);
      meta.id = newId;
      store.put(meta);
    } else {
      store.put(meta);
    }

    editingGameId = null;
    document.getElementById("metaModalBackdrop").style.display = "none";

    await loadAllGamesMeta();
    renderGames();
  };
};

/* ============================================================
   PART 6 — New Tab Mode + Embedded Preview
   ============================================================ */

function openGameInNewTab(id) {
  const htmlStore = tx("games_html");
  const req = htmlStore.get(id);

  req.onsuccess = () => {
    const html = req.result?.html;
    if (!html) return;

    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);

    window.open(url, "_blank");
  };
}

/* ============================================================
   FULLSCREEN BUTTON REPLACED WITH NEW TAB BUTTON
   ============================================================ */

function setupNewTabButton() {
  const bottomBar = document.querySelector(".bottombar");

  const btn = document.createElement("button");
  btn.className = "btn secondary";
  btn.textContent = "↗"; // open in new tab icon

  btn.onclick = () => {
    const id = gamesMeta.find(g =>
      g.title === document.getElementById("currentGameLabel").textContent
    )?.id;

    if (id) openGameInNewTab(id);
  };

  bottomBar.appendChild(btn);
}



/* ============================================================
   PART 7 — Initialization + UI Wiring + Final Glue Code
   ============================================================ */

/* ============================================================
   SEARCH BAR
   ============================================================ */

document.getElementById("search").oninput = () => {
  const active = document.querySelector(".nav-item.active")?.dataset.view || "all";
  renderGames(active);
};

/* ============================================================
   NAVIGATION (ALL / FAVORITES / RECENT)
   ============================================================ */

function setupNavigation() {
  const items = document.querySelectorAll(".nav-item");

  items.forEach(item => {
    item.onclick = () => {
      items.forEach(i => i.classList.remove("active"));
      item.classList.add("active");

      const view = item.dataset.view;
      renderGames(view);
    };
  });
}

/* ============================================================
   THEME TOGGLE
   ============================================================ */

document.getElementById("themeToggleBtn").onclick = () => {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  const next = current === "dark" ? "light" : "dark";

  applyTheme(next);
  saveSetting("theme", next);
};

/* ============================================================
   ACCENT PICKER
   ============================================================ */

document.getElementById("accentPicker").oninput = (e) => {
  const color = e.target.value;
  applyAccent(color);
  saveSetting("accent", color);
};

/* ============================================================
   RANDOM GAME BUTTON
   ============================================================ */

document.getElementById("randomBtn").onclick = () => {
  if (gamesMeta.length === 0) return;

  const random = gamesMeta[Math.floor(Math.random() * gamesMeta.length)];
  launchGame(random.id);
};

/* ============================================================
   SETTINGS IMPORT / EXPORT
   ============================================================ */

document.getElementById("exportSettingsBtn").onclick = () => {
  exportSettingsTxt();
};

document.getElementById("importSettingsBtn").onclick = () => {
  document.getElementById("importSettingsInput").click();
};

document.getElementById("importSettingsInput").onchange = (e) => {
  const file = e.target.files[0];
  if (file) importSettingsTxt(file);
};

/* ============================================================
   INITIALIZATION
   ============================================================ */

async function init() {
  document.getElementById("status").textContent = "Opening database…";

  await openDB();

  document.getElementById("status").textContent = "Loading settings…";

  const { theme, accent } = await loadSettings();
  applyTheme(theme);
  applyAccent(accent);

  document.getElementById("status").textContent = "Loading games…";

  await loadAllGamesMeta();
  renderGames();

  document.getElementById("status").textContent = "Ready";

  setupImportButtons();
  setupModeModal();
  setupMetaModal();
  setupEditMode();
  setupNavigation();
  setupNewTabButton();
  setupBigViewButton();
}

init();
