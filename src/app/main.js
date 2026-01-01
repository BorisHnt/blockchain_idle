import { createStore } from "./store.js";
import { createBus } from "./events.js";
import { clamp, formatNumber, formatRate, formatSeconds } from "./utils.js";
import * as boardModule from "../modules/board/board.module.js";

const STORAGE_KEY = "idle-techno-modular-v1";
const VERSION = "0.3.0-board";
const MAX_OFFLINE_SECONDS = 60 * 60 * 4;
const MODULE_CONFIG = {
  board: true,
};

const initialState = () => ({
  version: VERSION,
  resources: { ...boardModule.createBoardState().resources },
  board: boardModule.createBoardState(),
  modules: {},
  lastSaved: Date.now(),
});

const bus = createBus();
const storage = createStorage();
const store = createStore(loadState());
const modules = buildModules();
let lastFrame = performance.now();
let lastSave = performance.now();
let lastResources = { ...store.getState().resources };
let smoothedRates = { coin: 0, hash: 0, compute: 0, skill: 0, energy: 0 };

bootstrap();

function bootstrap() {
  const banner = document.getElementById("offline-gain");
  if (banner && !banner.textContent) {
    banner.textContent = "Chargement du moteur…";
  }
  renderVersion();
  attachControls();
  mountModules();
  renderHud(store.getState().resources, smoothedRates);
  requestAnimationFrame(loop);
}

function buildModules() {
  const ordered = [boardModule];
  return ordered.filter((mod) => MODULE_CONFIG[mod.id] !== false);
}

function mountModules() {
  const grid = document.getElementById("module-grid");
  modules.forEach((mod) => {
    const mountEl = ensureMount(mod.id, grid);
    mod.init({ store, bus, mountEl });
  });
}

function loop(now) {
  const dt = clamp((now - lastFrame) / 1000, 0.001, 1);
  lastFrame = now;
  applyPassive(dt);
  modules.forEach((mod) => mod.tick?.(dt));
  if (!modules.some((m) => m.id === "board")) {
    updateRates(dt);
  }
  modules.forEach((mod) => mod.render?.());
  if (now - lastSave > 3000) {
    persistState();
    lastSave = now;
  }
  requestAnimationFrame(loop);
}

function updateRates(dt) {
  const state = store.getState();
  const nextResources = state.resources;
  const rateKeys = Object.keys(smoothedRates);
  rateKeys.forEach((key) => {
    const delta = (nextResources[key] - (lastResources[key] || 0)) / dt;
    smoothedRates[key] = smoothedRates[key] * 0.7 + delta * 0.3;
  });
  lastResources = { ...nextResources };
  renderHud(nextResources, smoothedRates);
}

function renderHud(resources, rates) {
  const mapping = [
    ["coin", "stat-coin", "rate-coin", "CXT"],
    ["hash", "stat-hash", "rate-hash", "Hash"],
    ["compute", "stat-compute", "rate-compute", "Compute"],
    ["energy", "stat-energy", "rate-energy", "W"],
    ["skill", "stat-skill", "rate-skill", "XP"],
  ];
  mapping.forEach(([key, valueId, rateId, suffix]) => {
    const valueEl = document.getElementById(valueId);
    const rateEl = document.getElementById(rateId);
    if (valueEl) valueEl.textContent = `${formatNumber(resources[key] || 0)}${suffix ? ` ${suffix}` : ""}`;
    if (rateEl) rateEl.textContent = `${formatRate(rates[key] || 0)}/s`;
  });
}

function attachControls() {
  const saveBtn = document.getElementById("save-btn");
  const resetBtn = document.getElementById("reset-btn");
  const clearBtn = document.getElementById("clear-all-btn");
  saveBtn?.addEventListener("click", () => {
    persistState();
    flashHint("Sauvegardé");
  });
  resetBtn?.addEventListener("click", () => {
    if (confirm("Supprimer la sauvegarde et repartir de zéro ?")) {
      storage.removeItem(STORAGE_KEY);
      location.reload();
    }
  });
  clearBtn?.addEventListener("click", () => {
    if (confirm("Purger TOUT le stockage local pour ce jeu ? (sauvegardes, prefs)")) {
      try {
        window.localStorage.clear();
      } catch (e) {
        console.warn("clear storage failed", e);
      }
      location.reload();
    }
  });
}

function renderVersion() {
  const versionEl = document.getElementById("layout-version");
  if (versionEl) {
    versionEl.textContent = `Build ${VERSION}`;
  }
}

function ensureMount(id, grid) {
  const existing = document.getElementById(`mod-${id}`);
  if (existing) return existing;
  const el = document.createElement("section");
  el.id = `mod-${id}`;
  el.className = "module-slot";
  grid?.appendChild(el);
  return el;
}

function persistState() {
  const snapshot = store.getState();
  const now = Date.now();
  const safeSnapshot = {
    ...snapshot,
    lastSaved: now,
    board: snapshot.board ? { ...snapshot.board, lastSaved: now } : snapshot.board,
  };
  storage.setItem(STORAGE_KEY, JSON.stringify(safeSnapshot));
}

function loadState() {
  const defaults = initialState();
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return defaults;
  try {
    const parsed = JSON.parse(raw);
    const merged = {
      ...defaults,
      ...parsed,
      resources: { ...defaults.resources, ...(parsed.resources || {}) },
      modules: { ...defaults.modules, ...(parsed.modules || {}) },
      board: parsed.board ? { ...boardModule.createBoardState(), ...parsed.board } : defaults.board,
      lastSaved: parsed.lastSaved || Date.now(),
    };
    applyOfflineGain(merged);
    return merged;
  } catch (e) {
    console.warn("Save corrompue, reset", e);
    return defaults;
  }
}

function applyOfflineGain(state) {
  if (state.board) return;
  const offlineEl = document.getElementById("offline-gain");
  const now = Date.now();
  const elapsed = Math.min((now - (state.lastSaved || now)) / 1000, MAX_OFFLINE_SECONDS);
  if (elapsed <= 1) {
    if (offlineEl) offlineEl.textContent = "";
    return;
  }
  const passiveCoinRate = 0.05 * (state.modules?.cpu?.level || 1);
  const gain = elapsed * passiveCoinRate;
  state.resources.coin += gain;
  if (offlineEl) {
    offlineEl.textContent = `+${formatNumber(gain)} CXT hors-ligne (${formatSeconds(elapsed)})`;
  }
}

function flashHint(text) {
  const el = document.getElementById("save-hint");
  if (!el) return;
  el.textContent = text;
  el.style.color = "var(--accent)";
  setTimeout(() => {
    el.textContent = "Auto-sauvegarde locale";
    el.style.color = "var(--muted)";
  }, 1200);
}

function applyPassive(dt) {
  if (modules.some((m) => m.id === "board")) return;
  store.setState((prev) => {
    const nextResources = { ...prev.resources };
    nextResources.energy = (nextResources.energy || 0) + 60 * dt;
    nextResources.compute = (nextResources.compute || 0) + 0.6 * dt;
    return { ...prev, resources: nextResources };
  });
}

function createStorage() {
  const memory = {};
  try {
    const test = "__idle_test__";
    window.localStorage.setItem(test, "1");
    window.localStorage.removeItem(test);
    return window.localStorage;
  } catch (e) {
    console.warn("localStorage indisponible, fallback mémoire", e);
    return {
      getItem: (k) => memory[k],
      setItem: (k, v) => {
        memory[k] = String(v);
      },
      removeItem: (k) => {
        delete memory[k];
      },
    };
  }
}
