import { createStore } from "./store.js";
import { createBus } from "./events.js";
import { clamp, formatNumber, formatRate, formatSeconds } from "./utils.js";
import * as cpuModule from "../modules/cpu/cpu.module.js";
import * as gpuModule from "../modules/gpu/gpu.module.js";
import * as ramModule from "../modules/ram/ram.module.js";
import * as algorithmsModule from "../modules/algorithms/algorithms.module.js";
import * as rndModule from "../modules/rnd/rnd.module.js";
import * as coolingModule from "../modules/cooling/cooling.module.js";

const STORAGE_KEY = "idle-techno-modular-v1";
const VERSION = "0.2.0-modular";
const MAX_OFFLINE_SECONDS = 60 * 60 * 4;
const MODULE_CONFIG = {
  cpu: true,
  gpu: true,
  ram: true,
  algorithms: true,
  rnd: true,
  cooling: true,
};

const initialState = () => ({
  version: VERSION,
  resources: { coin: 200, hash: 0, compute: 6, energy: 140, skill: 0 },
  modules: {
    cpu: { level: 1, cores: 1, unlocked: true, heat: 0 },
    gpu: { level: 1, unlocked: true, temperature: 0 },
    ram: { level: 0, unlocked: false },
    algorithms: { level: 0, unlocked: false },
    rnd: { level: 0, unlocked: false },
    cooling: { level: 1, unlocked: true, efficiency: 1 },
  },
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
  const ordered = [coolingModule, algorithmsModule, ramModule, gpuModule, cpuModule, rndModule];
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
  updateRates(dt);
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
  const safeSnapshot = {
    ...snapshot,
    lastSaved: Date.now(),
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
