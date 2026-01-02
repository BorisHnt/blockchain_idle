import { clamp, formatNumber, formatRate, formatSeconds, formatBandwidth, formatBandwidthRate } from "../../app/utils.js";
import { createWires } from "./wires.js";
import { createCablage } from "./cablage.js";
import { bindIoDots, createIoContextMenu } from "./interactions-io.js";
import {
  POWER_CELLS_PER_BLOCK,
  POWER_CELL_BLOCKS,
  getEnergyUpgradeCost,
  getEnergyLevelScale,
  getGenericUpgradeCost,
  getPowerCellCost,
  getUnlockNextBlockCost as computeUnlockBlockCost,
  getPowerMultiplierCost,
} from "./board.balance.js";

export const id = "board";
export const name = "Playfield";

const LAYOUT_VERSION = 3;
const BOARD_STATE_VERSION = 4;
const MAX_OFFLINE_SECONDS = 60 * 60 * 12; // 12h cap
const TICK_MS = 250;
const GPU_HASH_PER_MO = 0.23; // hash produits par Mo consommé au niveau 1 (hors scaling)
const HASH_PER_MHZ_PER_CELL = 1000;
const RAM_CHARGE_BASE = 10;
const RAM_CHARGE_GROWTH = 1.15;
const RAM_DISCHARGE_BASE = 8;
const RAM_DISCHARGE_GROWTH = 1.15;
const RAM_EPS = 0.1; // petite tolérance pour éviter les clignotements (Mo)

const UTIL_GAUGE_IDS = new Set(["validator", "gpu", "ram", "cpu"]);

const NODES = [
  {
    id: "energy",
    name: "Energy Source",
    caption: "Alimentation du réseau",
    type: "source",
    output: "energy",
    baseRate: 500,
    baseCost: 0,
    x: 80,
    y: 100,
    startLevel: 0,
    startUnlocked: true,
  },
  {
    id: "validator",
    name: "Network Computer",
    caption: "Transforme l'énergie en bandwidth",
    type: "source",
    output: "bandwidth",
    energyUse: 150,
    baseRate: 4.2,
    baseCost: 60,
    x: 80,
    y: 450,
    startLevel: 1,
    startUnlocked: true,
  },
  {
    id: "ram",
    name: "RAM Cache",
    caption: "Précharge le bandwidth en data",
    input: "bandwidth",
    output: "data",
    efficiency: 1.25,
    energyUse: 60,
    baseRate: 1.4,
    baseCost: 200,
    x: 420,
    y: 400,
    startLevel: 1,
    startUnlocked: true,
    capBase: 400,
    capGrowth: 1.35,
  },
  {
    id: "gpu",
    name: "GPU Farm",
    caption: "Data → Hash",
    input: "data",
    output: "hash",
    energyUse: 120,
    baseRate: 2.3,
    baseCost: 120,
    x: 420,
    y: 160,
    startLevel: 1,
    startUnlocked: true,
  },
  {
    id: "cpu",
    name: "CPU Miner",
    caption: "Hash → Crédits",
    input: "hash",
    output: "coin",
    energyUse: 85,
    baseRate: 1.1,
    baseCost: 140,
    x: 760,
    y: 160,
    startLevel: 1,
    startUnlocked: true,
    coresMax: 8,
    baseCores: 1,
    coreCost: 120,
    coreGrowth: 1.4,
  },
  {
    id: "optimizer",
    name: "Algo Optimizer",
    caption: "Hash → Crédits optimisés",
    input: "hash",
    output: "coin",
    efficiency: 1.35,
    energyUse: 120,
    baseRate: 0.9,
    baseCost: 260,
    unlock: { coin: 320, skill: 2 },
    x: 760,
    y: 400,
  },
  {
    id: "lab",
    name: "R&D Lab",
    caption: "Crédits → Compétences",
    input: "coin",
    output: "skill",
    energyUse: 80,
    baseRate: 0.35,
    baseCost: 180,
    unlock: { coin: 180 },
    x: 1100,
    y: 160,
  },
  {
    id: "firmware",
    name: "Firmware Uploader",
    caption: "Compétences → Bandwidth",
    input: "skill",
    output: "bandwidth",
    energyUse: 110,
    baseRate: 0.8,
    baseCost: 240,
    unlock: { coin: 400, skill: 1 },
    x: 1100,
    y: 400,
  },
  {
    id: "collector",
    name: "Collector",
    caption: "Agrège les gains",
    input: "coin",
    output: "coin",
    baseRate: 1.05,
    efficiency: 1.25,
    baseCost: 260,
    hideOutputAnchor: true,
    x: 1460,
    y: 280,
    startUnlocked: true,
    startLevel: 1,
  },
];

let store;
let bus;
let mount;
let playfield;
let nodesContainer;
let wiresSvg;
let offlineGainEl;

let state;
let bindings = {};
let resourceRates = { coin: 0, hash: 0, bandwidth: 0, skill: 0, energy: 0 };
let drag = null;
let linking = null;
let accumulator = 0;
let lastSave = performance.now();
let wires;
let cablage;
let ioMenu;
let nodeMetrics = {};
let energyProdRate = 0;
let energyBalanceRate = 0;
let lastDelta = 1;
const VAL_UPGRADE_Q = 1.15;
const VAL_UPGRADE_B = 5 / (VAL_UPGRADE_Q - 1); // impose cost(2)=125, cost(1)=60
const CPU_HASH_PER_SEC_BASE = 1.1;
const CPU_HASH_SCALE = 1.18;
const CPU_HASH_CAP_PER_TICK = 999999;
const GPU_CHUNK_SIZES = [32, 64, 96, 128, 160, 192, 224, 256];

export function createBoardState() {
  return {
    resources: { coin: 200, hash: 0, bandwidth: 0, skill: 0, energy: 0 },
    nodes: buildDefaultNodes(),
    layout: buildDefaultLayout(),
    connections: [],
    layoutVersion: LAYOUT_VERSION,
    boardVersion: BOARD_STATE_VERSION,
    powerCells: createDefaultPowerCells(),
    lastSaved: Date.now(),
  };
}

export function init({ store: appStore, bus: appBus, mountEl }) {
  store = appStore;
  bus = appBus;
  mount = mountEl;
  offlineGainEl = document.getElementById("offline-gain");
  cablage = createCablage({
    getNodeMeta,
    hasInputAnchor,
    hasOutputAnchor,
    hasEnergyInput,
    isUnlocked,
    flashHint,
  });
  ensureBoardState();
  renderLayout();
  ioMenu = createIoContextMenu({
    playfield,
    cablage,
    getNodeMeta,
    getConnections: () => state.connections,
    onDisconnect: (conn) => disconnectConnection(conn),
  });
  wires = createWires({
    playfield,
    wiresSvg,
    getNodeMeta,
    isUnlocked,
    getLevel,
  });
  applyOfflineProgress(state);
  renderNodes();
  wires.render(state.connections, bindings);
  updateHud();
  window.addEventListener("resize", onResize);
}

export function tick(dt) {
  const step = TICK_MS / 1000;
  accumulator += dt;
  while (accumulator >= step) {
    stepSimulation(step);
    accumulator -= step;
  }
}

export function render() {
  // Rendering handled during simulation; nothing extra per frame for now.
}

function ensureBoardState() {
  const appState = store.getState();
  const merged = mergeBoardState(appState?.board || createBoardState());
  state = merged;
  syncStore();
}

function mergeBoardState(saved) {
  const baseNodes = buildDefaultNodes();
  const baseLayout = buildDefaultLayout();
  const needsReset = saved.boardVersion !== BOARD_STATE_VERSION;
  const savedResources = needsReset ? createBoardState().resources : { ...createBoardState().resources, ...(saved.resources || {}) };
  const bandwidth = savedResources.bandwidth ?? savedResources.compute ?? 0;
  const mergedResources = { ...savedResources, bandwidth };
  delete mergedResources.compute;
  delete mergedResources.data;
  const merged = {
    resources: mergedResources,
    nodes: needsReset ? { ...baseNodes } : { ...baseNodes, ...(saved.nodes || {}) },
    powerCells: needsReset ? createDefaultPowerCells() : mergePowerCells(saved.powerCells),
    layout:
      needsReset || saved.layoutVersion !== LAYOUT_VERSION
        ? { ...baseLayout }
        : { ...baseLayout, ...(saved.layout || {}) },
    connections:
      needsReset || !Array.isArray(saved.connections)
        ? []
        : saved.connections
            .filter(Boolean)
            .map((c) => ({ ...c, kind: c.kind === "resource" ? "data" : c.kind || "data" })),
    layoutVersion: LAYOUT_VERSION,
    boardVersion: BOARD_STATE_VERSION,
    lastSaved: saved.lastSaved || Date.now(),
  };
  NODES.forEach((meta) => {
    const pos = merged.layout[meta.id];
    if (!pos || !isFinite(pos.x) || !isFinite(pos.y)) {
      merged.layout[meta.id] = { x: meta.x, y: meta.y };
    }
  });
  NODES.forEach((meta) => {
    const nodeState = merged.nodes[meta.id] || {};
    merged.nodes[meta.id] = {
      level: typeof nodeState.level === "number" ? nodeState.level : baseNodes[meta.id].level,
      unlocked:
        typeof nodeState.unlocked === "boolean"
          ? nodeState.unlocked
          : nodeState.level > 0 || baseNodes[meta.id].unlocked,
      cores:
        meta.coresMax && typeof nodeState.cores === "number"
          ? nodeState.cores
          : meta.coresMax
          ? meta.baseCores || 0
          : undefined,
      capLevel:
        meta.id === "ram" && typeof nodeState.capLevel === "number"
          ? nodeState.capLevel
          : meta.id === "ram"
          ? 1
          : undefined,
      // GPU extended state
      freqLevel: meta.id === "gpu" ? Math.max(1, nodeState.freqLevel || nodeState.level || 1) : undefined,
      cellsPerGpu: meta.id === "gpu" ? Math.max(1, nodeState.cellsPerGpu || 1) : undefined,
      gpuCount: meta.id === "gpu" ? Math.max(1, nodeState.gpuCount || 1) : undefined,
      purchasedGpuCount: meta.id === "gpu" ? Math.max(0, nodeState.purchasedGpuCount || 0) : undefined,
      cardCount: meta.id === "gpu" ? Math.max(1, nodeState.cardCount || 1) : undefined,
      chunkTier: meta.id === "gpu" ? Math.max(0, nodeState.chunkTier || 0) : undefined,
      compressionLevel: meta.id === "gpu" ? Math.max(0, nodeState.compressionLevel || 0) : undefined,
    };
    if (meta.id === "ram" && merged.nodes[meta.id].level < 1) {
      merged.nodes[meta.id].level = 1;
      merged.nodes[meta.id].unlocked = true;
    }
    if (meta.id === "collector") {
      merged.nodes[meta.id].unlocked = true;
      merged.nodes[meta.id].level = Math.max(1, merged.nodes[meta.id].level || 0);
    }
  });
  merged.connections = merged.connections.filter((c) => {
    const from = getNodeMeta(c.from);
    const to = getNodeMeta(c.to);
    return (
      from &&
      to &&
      hasOutputAnchor(from) &&
      (isEnergyConnection(c)
        ? hasEnergyInput(to) && from.output === "energy"
        : hasInputAnchor(to) && from.output === to.input)
    );
  });
  const ramNode = merged.nodes.ram || {};
  const savedFill =
    typeof saved?.resources?.data === "number"
      ? saved.resources.data
      : typeof ramNode.fill === "number"
      ? ramNode.fill
      : 0;
  const cap = getRamCapacity(ramNode.capLevel || 1);
  merged.nodes.ram = {
    ...ramNode,
    fill: clamp(savedFill, 0, cap),
    discharging: typeof ramNode.discharging === "boolean" ? ramNode.discharging : false,
  };
  return merged;
}

function renderLayout() {
  mount.innerHTML = `
    <div class="playfield" id="playfield">
      <svg id="wires" class="wires" aria-hidden="true"></svg>
      <div id="nodes" class="nodes"></div>
    </div>
  `;
  playfield = mount.querySelector("#playfield");
  nodesContainer = mount.querySelector("#nodes");
  wiresSvg = mount.querySelector("#wires");
}

function stepSimulation(delta) {
  const now = performance.now();
  const net = runProduction(delta);
  smoothRates(net, delta);
  updateHud();
  syncStore();
  if (now - lastSave > 1500) {
    state.lastSaved = Date.now();
    syncStore();
    lastSave = now;
  }
}

function syncStore() {
  const snapshot = deepClone(state);
  store.setState((prev) => ({
    ...prev,
    resources: { ...snapshot.resources },
    board: snapshot,
  }));
}

function buildDefaultNodes() {
  return NODES.reduce((acc, meta) => {
    const level = meta.startLevel || 0;
    acc[meta.id] = {
      level,
      unlocked: meta.startUnlocked || level > 0,
      cores: meta.coresMax ? meta.baseCores || 0 : undefined,
      capLevel: meta.id === "ram" ? 1 : undefined,
      fill: meta.id === "ram" ? 0 : undefined,
      discharging: meta.id === "ram" ? false : undefined,
      ...(meta.id === "gpu"
        ? {
            freqLevel: 1,
            cellsPerGpu: 1,
            gpuCount: 1,
            purchasedGpuCount: 0,
            cardCount: 1,
            chunkTier: 0,
            compressionLevel: 0,
          }
        : {}),
    };
    return acc;
  }, {});
}

function createDefaultPowerCells() {
  return {
    blocks: POWER_CELL_BLOCKS.map((_, idx) => ({ unlocked: idx === 0, cells: 0 })),
    multiplier: 0,
  };
}

function mergePowerCells(saved) {
  const defaults = createDefaultPowerCells();
  if (!saved || typeof saved !== "object") return defaults;
  const blocks = POWER_CELL_BLOCKS.map((_, idx) => {
    const b = saved.blocks?.[idx] || {};
    return {
      unlocked: typeof b.unlocked === "boolean" ? b.unlocked : idx === 0,
      cells: clamp(b.cells || 0, 0, POWER_CELLS_PER_BLOCK),
    };
  });
  return {
    blocks,
    multiplier: clamp(saved.multiplier || 0, 0, 999),
  };
}

function buildDefaultLayout() {
  return NODES.reduce((acc, meta) => {
    acc[meta.id] = { x: meta.x, y: meta.y };
    return acc;
  }, {});
}

function deepClone(obj) {
  if (typeof structuredClone === "function") return structuredClone(obj);
  return JSON.parse(JSON.stringify(obj));
}

function hasInputAnchor(meta) {
  return !!meta.input;
}

function hasOutputAnchor(meta) {
  return !!meta.output && !meta.hideOutputAnchor;
}

function hasEnergyInput(meta) {
  return !!meta.energyUse && meta.id !== "energy";
}

function hasUtilGauge(meta) {
  return UTIL_GAUGE_IDS.has(meta.id);
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function getValidatorEnergyUse(level) {
  const base = 150;
  const growth = 1.18;
  return round1(base * Math.pow(growth, Math.max(0, level - 1)));
}

function getValidatorUpgradeCost(currentLevel) {
  const n = currentLevel + 1; // cible
  const cost = 60 * n + VAL_UPGRADE_B * (Math.pow(VAL_UPGRADE_Q, n - 1) - 1);
  return round1(cost);
}

function getEnergyUse(meta, level) {
  if (meta.id === "validator") return getValidatorEnergyUse(level);
  return meta.energyUse || 0;
}

function isEnergyConnection(conn) {
  return conn.kind === "energy";
}

function applyOfflineProgress(savedState) {
  const now = Date.now();
  const elapsed = Math.min((now - (savedState.lastSaved || now)) / 1000, MAX_OFFLINE_SECONDS);
  if (elapsed <= 0) {
    if (offlineGainEl) offlineGainEl.textContent = "";
    return;
  }
  const steps = Math.ceil(elapsed / 5); // 5s chunks
  const stepDuration = elapsed / steps;
  let gainedCoin = 0;
  for (let i = 0; i < steps; i++) {
    const net = simulateProduction(stepDuration, savedState);
    gainedCoin += net.coin > 0 ? net.coin : 0;
  }
  if (offlineGainEl) {
    offlineGainEl.textContent =
      gainedCoin > 0 ? `+${formatNumber(gainedCoin)} CXT hors-ligne (${formatSeconds(elapsed)})` : "";
  }
}

function getNodeMeta(id) {
  return NODES.find((n) => n.id === id);
}

function getLevel(id) {
  return state.nodes[id]?.level || 0;
}

function isUnlocked(id) {
  return !!state.nodes[id]?.unlocked;
}

function getUpgradeCost(id) {
  const meta = getNodeMeta(id);
  const level = getLevel(id);
  if (meta.id === "ram") {
    return getRamFreqCost(level);
  }
  if (meta.id === "energy") {
    return getEnergyUpgradeCost(level);
  }
  if (meta.id === "validator") {
    return getValidatorUpgradeCost(level);
  }
  return getGenericUpgradeCost(meta.baseCost, level);
}

function getCores(id) {
  return state.nodes[id]?.cores || 0;
}

function getCoreCost(id) {
  const meta = getNodeMeta(id);
  if (!meta?.coresMax) return Infinity;
  const cores = getCores(id);
  const base = meta.coreCost || meta.baseCost || 100;
  const growth = meta.coreGrowth || 1.35;
  return Math.round(base * Math.pow(growth, Math.max(0, cores - (meta.baseCores || 0))));
}

function getRamCapLevel() {
  return state.nodes.ram?.capLevel || 1;
}

function getRamCapacity(level = getRamCapLevel()) {
  const meta = getNodeMeta("ram");
  const base = meta?.capBase || 400;
  const growth = meta?.capGrowth || 1.35;
  return base * Math.pow(growth, Math.max(0, level - 1));
}

function getRamCapCost(level = getRamCapLevel()) {
  const base = 150;
  const growth = 1.2;
  return Math.round(base * Math.pow(growth, Math.max(0, level - 1)));
}

function getRamFreqCost(level) {
  return Math.round(200 * Math.pow(1.22, Math.max(0, level - 1)));
}

function getRamChargeRate(level) {
  return RAM_CHARGE_BASE * Math.pow(RAM_CHARGE_GROWTH, Math.max(0, level - 1));
}

function getRamDischargeRate(level) {
  return RAM_DISCHARGE_BASE * Math.pow(RAM_DISCHARGE_GROWTH, Math.max(0, level - 1));
}

function getRate(meta, level) {
  if (meta.id === "energy") {
    return getEnergyOutputPerSec(level);
  }
  if (meta.id === "validator") {
    return meta.baseRate * Math.pow(1.2, level - 1);
  }
  if (meta.id === "cpu") {
    return CPU_HASH_PER_SEC_BASE * Math.pow(CPU_HASH_SCALE, level - 1);
  }
  if (meta.id === "ram") {
    return getRamChargeRate(level) * (meta.efficiency || 1);
  }
  const scale = Math.pow(1.18, level - 1);
  return meta.baseRate * scale;
}

function gpuFreqMult(lvl) {
  if (lvl <= 1) return 1.1;
  if (lvl <= 15) {
    const t = (lvl - 1) / 14;
    return 1.1 + (1.075 - 1.1) * t;
  }
  if (lvl <= 25) {
    const t = (lvl - 15) / 10;
    return 1.075 + (1.05 - 1.075) * t;
  }
  return 1.05;
}

function gpuFreqMHz(baseMHz, level) {
  let f = baseMHz;
  for (let i = 1; i <= level; i++) {
    f *= gpuFreqMult(i);
  }
  return f;
}

function gpuCompression(level) {
  const a = 0.0797756811715;
  const b = 0.7797105730328;
  const c = 1.5017574721675;
  const cap = 0.95;
  if (level <= 0) return 0;
  return Math.min(cap, cap * Math.pow(1 - Math.exp(-a * Math.pow(level, b)), c));
}

function gpuHashesPerChunk(chunkSizeKo, hashPerKo, compression) {
  const base = chunkSizeKo * hashPerKo;
  return Math.ceil(base * (1 + compression));
}

function getGpuFreqCost(currentLevel) {
  const base = 100;
  const step = 55;
  return Math.round(base + step * Math.max(0, currentLevel - 1));
}

function getGpuCellsCost(nextCount) {
  const base = 250;
  const mult = 1.14;
  return Math.round(base * Math.pow(mult, Math.max(0, nextCount - 1)));
}

function getGpuCountCost(globalIndex) {
  const base = 5000;
  const mult = 1.25;
  return Math.round(base * Math.pow(mult, Math.max(0, globalIndex - 1)));
}

function getGpuCardCost(cardNumber) {
  if (cardNumber === 2) return 1_000_000;
  if (cardNumber === 3) return 50_000_000;
  if (cardNumber === 4) return 1_000_000_000;
  return Infinity;
}

function getGpuChunkCost(nextTier) {
  const base = 250;
  const mult = 1.35;
  return Math.round(base * Math.pow(mult, Math.max(0, nextTier)));
}

function getGpuCompressionCost(nextLevel) {
  const base = 600;
  const mult = 1.18;
  return Math.round(base * Math.pow(mult, Math.max(0, nextLevel - 1)));
}

function getGpuChunkSize(tier) {
  if (tier < 0) return GPU_CHUNK_SIZES[0];
  if (tier >= GPU_CHUNK_SIZES.length) return GPU_CHUNK_SIZES[GPU_CHUNK_SIZES.length - 1];
  return GPU_CHUNK_SIZES[tier];
}

function getGpuState(sourceState = state) {
  const gpu = sourceState?.nodes?.gpu || {};
  return {
    freqLevel: Math.max(1, gpu.freqLevel || gpu.level || 1),
    cellsPerGpu: Math.max(1, gpu.cellsPerGpu || 1),
    gpuCount: Math.max(1, gpu.gpuCount || 1),
    purchasedGpuCount: Math.max(0, gpu.purchasedGpuCount || 0),
    cardCount: Math.max(1, gpu.cardCount || 1),
    chunkTier: Math.max(0, gpu.chunkTier || 0),
    compressionLevel: Math.max(0, gpu.compressionLevel || 0),
  };
}

function hasInputConnection(id) {
  return state.connections.some((c) => c.to === id && !isEnergyConnection(c));
}

function hasEnergyConnection(id) {
  return state.connections.some((c) => c.to === id && isEnergyConnection(c));
}

function tryCreateConnection(fromId, toId, targetType = "data") {
  if (!fromId || !toId || fromId === toId) return;
  ioMenu?.hide();
  state = cablage.tryCreate(state, fromId, toId, targetType);
  refreshWires();
  syncStore();
}

function canUnlock(meta) {
  if (!meta.unlock) return true;
  const { coin = 0, skill = 0 } = meta.unlock;
  return state.resources.coin >= coin && state.resources.skill >= skill;
}

function formatUnlockCost(cost) {
  if (!cost) return "Gratuit";
  const parts = [];
  if (cost.coin) parts.push(`${formatNumber(cost.coin)} CXT`);
  if (cost.skill) parts.push(`${formatNumber(cost.skill)} XP`);
  return parts.join(" + ");
}

function unlockNode(id) {
  const meta = getNodeMeta(id);
  if (!meta.unlock && meta.id !== "energy") return;
  if (meta.id !== "energy") {
    if (!canUnlock(meta)) {
      flashHint("Conditions non remplies");
      return;
    }
    const { coin = 0, skill = 0 } = meta.unlock;
  state.resources.coin -= coin;
  state.resources.skill -= skill;
  }
  state.nodes[id] = { ...state.nodes[id], unlocked: true, level: Math.max(1, getLevel(id)) };
  updateNodeCard(id);
  refreshWires();
  syncStore();
}

function handleUpgrade(id) {
  if (!isUnlocked(id)) {
    unlockNode(id);
    return;
  }
  if (id === "ram") {
    upgradeRamFrequency();
    return;
  }
  const cost = getUpgradeCost(id);
  if (state.resources.coin < cost) {
    flashHint("Pas assez de crédits");
    return;
  }
  state.resources.coin -= cost;
  state.nodes[id] = { ...state.nodes[id], level: getLevel(id) + 1, unlocked: true };
  updateNodeCard(id);
  refreshWires();
  syncStore();
}

function addCore(id) {
  const meta = getNodeMeta(id);
  if (!meta?.coresMax) return;
  const cores = getCores(id);
  if (cores >= meta.coresMax) {
    flashHint("Cores max");
    return;
  }
  const cost = getCoreCost(id);
  if (state.resources.coin < cost) {
    flashHint("Pas assez de crédits");
    return;
  }
  state.resources.coin -= cost;
  state.nodes[id] = { ...state.nodes[id], cores: cores + 1 };
  updateNodeCard(id);
  refreshWires();
  syncStore();
}

function upgradeRamCapacity() {
  const level = getRamCapLevel();
  const cost = getRamCapCost(level);
  if (state.resources.coin < cost) {
    flashHint("Pas assez de crédits");
    return;
  }
  state.resources.coin -= cost;
  state.nodes.ram = {
    ...state.nodes.ram,
    unlocked: true,
    level: Math.max(1, getLevel("ram")),
    capLevel: level + 1,
  };
  updateNodeCard("ram");
  refreshWires();
  syncStore();
}

function upgradeRamFrequency() {
  const level = getLevel("ram");
  const cost = getRamFreqCost(level);
  if (state.resources.coin < cost) {
    flashHint("Pas assez de crédits");
    return;
  }
  state.resources.coin -= cost;
  state.nodes.ram = {
    ...state.nodes.ram,
    unlocked: true,
    level: level + 1,
    capLevel: getRamCapLevel(),
  };
  updateNodeCard("ram");
  refreshWires();
  syncStore();
}

function upgradeGpuFreq() {
  const gpu = state.nodes.gpu || {};
  const level = gpu.freqLevel || 1;
  const cost = getGpuFreqCost(level);
  if (state.resources.coin < cost) {
    flashHint("Pas assez de crédits");
    return;
  }
  state.resources.coin -= cost;
  state.nodes.gpu = { ...gpu, freqLevel: level + 1, unlocked: true };
  updateNodeCard("gpu");
  refreshWires();
  syncStore();
}

function upgradeGpuCells() {
  const gpu = state.nodes.gpu || {};
  const nextCount = (gpu.cellsPerGpu || 1) + 1;
  const cost = getGpuCellsCost(nextCount);
  if (state.resources.coin < cost) {
    flashHint("Pas assez de crédits");
    return;
  }
  state.resources.coin -= cost;
  state.nodes.gpu = { ...gpu, cellsPerGpu: nextCount, unlocked: true };
  updateNodeCard("gpu");
  refreshWires();
  syncStore();
}

function upgradeGpuCount() {
  const gpu = state.nodes.gpu || {};
  const totalGpus = gpu.gpuCount || 1;
  const next = totalGpus + 1;
  const purchased = gpu.purchasedGpuCount || 0;
  const cost = getGpuCountCost(purchased + 1);
  const cardCount = gpu.cardCount || 1;
  const maxPerCard = 32;
  if (next > cardCount * maxPerCard) {
    flashHint("Cartes pleines (32 GPU max par carte)");
    return;
  }
  if (state.resources.coin < cost) {
    flashHint("Pas assez de crédits");
    return;
  }
  state.resources.coin -= cost;
  state.nodes.gpu = {
    ...gpu,
    gpuCount: next,
    purchasedGpuCount: purchased + 1,
    unlocked: true,
  };
  updateNodeCard("gpu");
  refreshWires();
  syncStore();
}

function upgradeGpuCard() {
  const gpu = state.nodes.gpu || {};
  const cardCount = gpu.cardCount || 1;
  const nextCard = cardCount + 1;
  if (nextCard > 4) {
    flashHint("Cartes max atteintes");
    return;
  }
  const cost = getGpuCardCost(nextCard);
  if (state.resources.coin < cost) {
    flashHint("Pas assez de crédits");
    return;
  }
  state.resources.coin -= cost;
  // bonus GPU offert (1 GPU avec 1 cellule)
  const bonusGpu = (gpu.gpuCount || 1) + 1;
  state.nodes.gpu = {
    ...gpu,
    cardCount: nextCard,
    gpuCount: bonusGpu,
    unlocked: true,
  };
  updateNodeCard("gpu");
  refreshWires();
  syncStore();
}

function upgradeGpuChunk() {
  const gpu = state.nodes.gpu || {};
  const tier = gpu.chunkTier || 0;
  const nextTier = tier + 1;
  if (nextTier >= GPU_CHUNK_SIZES.length) {
    flashHint("Chunk max");
    return;
  }
  const cost = getGpuChunkCost(nextTier);
  if (state.resources.coin < cost) {
    flashHint("Pas assez de crédits");
    return;
  }
  state.resources.coin -= cost;
  state.nodes.gpu = { ...gpu, chunkTier: nextTier, unlocked: true };
  updateNodeCard("gpu");
  refreshWires();
  syncStore();
}

function upgradeGpuCompression() {
  const gpu = state.nodes.gpu || {};
  const level = gpu.compressionLevel || 0;
  const nextLevel = level + 1;
  const cost = getGpuCompressionCost(nextLevel);
  if (state.resources.coin < cost) {
    flashHint("Pas assez de crédits");
    return;
  }
  state.resources.coin -= cost;
  state.nodes.gpu = { ...gpu, compressionLevel: nextLevel, unlocked: true };
  updateNodeCard("gpu");
  refreshWires();
  syncStore();
}

function renderNodes() {
  bindings = {};
  nodesContainer.innerHTML = "";
  NODES.forEach((meta) => {
    const pos = getNodePosition(meta.id);
    const level = getLevel(meta.id);
    const card = document.createElement("div");
    card.className = "node-card";
    card.classList.add(`node-${meta.id}`);
    if (meta.id === "gpu") {
      card.classList.add("gpu-card");
    }
    card.style.left = `${pos.x}px`;
    card.style.top = `${pos.y}px`;
    card.dataset.node = meta.id;

    card.innerHTML = `
      <div class="node-header drag-handle">
        <div class="drag-icon">⋮</div>
        <div class="node-title-block">
          <div class="node-title">${meta.name}</div>
        </div>
        <div class="node-level">Niv. <span data-level>${getLevel(meta.id)}</span></div>
      </div>
      <div class="node-subline">${meta.caption}</div>
      ${
        meta.id === "energy"
          ? `<div class="energy-hero">
              <div class="energy-logo" data-energy-logo>
                <svg viewBox="0 0 80 120" aria-hidden="true" focusable="false">
                  <path d="M44 6 14 70h22l-8 44 38-68H46l8-40z" />
                </svg>
              </div>
              <div class="energy-bar">
                <div class="energy-bar-fill" data-energy-bar></div>
              </div>
            </div>`
          : ""
      }
      <div class="io-group ${meta.id === "energy" ? "energy-io" : ""}">
        <div class="io-column io-column-left">
          ${hasEnergyInput(meta) ? `<div class="io-dot energy" title="Énergie" data-io="energy"></div>` : ""}
          ${hasInputAnchor(meta) ? `<div class="io-dot input" title="Entrée" data-io="data"></div>` : ""}
        </div>
        <div class="${meta.id === "energy" ? "flow energy-flow" : "flow"}">
          ${
            meta.input
              ? `<span class="pill input">In: ${label(meta.input)}</span>`
              : meta.id === "energy" || meta.id === "validator"
              ? ""
              : `<span class="pill source">Source</span>`
          }
          ${hasEnergyInput(meta) ? `<span class="pill energy">Power: ${getEnergyUse(meta, level)}W</span>` : ""}
          ${
            hasOutputAnchor(meta)
              ? `<span class="pill ${meta.output === "energy" ? "energy" : "output"}">Out: ${
                  meta.output === "energy" ? "Energy" : label(meta.output)
                }</span>`
              : meta.id === "collector"
              ? ""
              : `<span class="pill output muted">Out: -</span>`
          }
        </div>
        <div class="io-column io-column-right">
          ${
            hasOutputAnchor(meta)
              ? `<div class="io-dot output ${meta.output === "energy" ? "energy" : ""}" title="Sortie" data-io="output" data-out-type="${meta.output}"></div>`
              : ""
          }
        </div>
      </div>
      <div class="node-body">
        <div class="node-row"><span>Production</span><span class="node-rate" data-rate>0/s</span></div>
        ${
          meta.id === "ram"
            ? `<div class="ram-meter">
                <div class="ram-meter-bar">
                  <div class="ram-meter-fill" data-ram-fill></div>
                </div>
                <div class="node-row ram-meter-row">
                  <span data-ram-fill-text>0 / 0</span>
                  <span class="muted" data-ram-fill-percent>0%</span>
                </div>
              </div>`
            : ""
        }
        ${
          hasUtilGauge(meta)
            ? `<div class="node-util">
                <div class="node-row util-row"><span>Utilisation</span><span data-util-label>0%</span></div>
                <div class="util-bar"><div class="util-bar-fill" data-util-bar></div></div>
              </div>`
            : ""
        }
        ${
          meta.id === "ram"
            ? `<div class="ram-stats">
                <div class="node-row"><span>Charge</span><span data-ram-charge>0</span></div>
                <div class="node-row"><span>Décharge</span><span data-ram-discharge>0</span></div>
              </div>`
            : ""
        }
        ${
          meta.id === "gpu"
            ? `<div class="gpu-stats">
                <div class="node-row small"><span>Chunk</span><span data-gpu-chunk>0 Ko</span></div>
                <div class="node-row small"><span>Compression</span><span data-gpu-comp>0%</span></div>
                <div class="node-row small"><span>GPUs</span><span data-gpu-count>0</span></div>
              </div>`
            : ""
        }
        ${
          meta.id === "gpu"
            ? `<div class="node-row small"><span>Data</span><span data-gpu-data>0</span></div>
               <div class="node-row small"><span>Hash</span><span data-gpu-hash>0</span></div>`
            : ""
        }
        ${
          meta.id === "cpu"
            ? `<div class="node-row small"><span>Hash</span><span data-cpu-hash>0</span></div>
               <div class="node-row small"><span>Crypto</span><span data-cpu-coin>0</span></div>`
            : ""
        }
        <div class="node-row" ${meta.id === "collector" || meta.id === "ram" ? 'style="display:none;"' : ""}><span>Coût</span><span data-cost>0</span></div>
        ${
          meta.id === "ram"
            ? `<div class="ram-upgrades">
                <div class="ram-upgrade">
                  <div class="node-row"><span>Capacité</span><span data-ram-cap>0</span></div>
                  <button data-ram-cap-btn>Capacité +1</button>
                  <div class="muted small" data-ram-cap-cost>Coût: 0 CXT</div>
                </div>
                <div class="ram-upgrade">
                  <div class="node-row"><span>Fréquence</span><span data-ram-freq>0</span></div>
                  <button data-ram-freq-btn>Fréquence +1</button>
                  <div class="muted small" data-ram-freq-cost>Coût: 0 CXT</div>
                </div>
              </div>`
            : ""
        }
        ${
          meta.id === "gpu"
            ? `<div class="gpu-upgrades">
                <div class="ram-upgrade">
                  <div class="node-row"><span>Fréquence</span><span data-gpu-freq>0</span></div>
                  <button data-gpu-freq-btn>Fréquence +1</button>
                  <div class="muted small" data-gpu-freq-cost>Coût: 0 CXT</div>
                </div>
                <div class="ram-upgrade">
                  <div class="node-row"><span>Cellules/GPU</span><span data-gpu-cells>0</span></div>
                  <button data-gpu-cells-btn>Cellule +1</button>
                  <div class="muted small" data-gpu-cells-cost>Coût: 0 CXT</div>
                </div>
                <div class="ram-upgrade">
                  <div class="node-row"><span>GPUs</span><span data-gpu-gpus>0</span></div>
                  <button data-gpu-gpus-btn>GPU +1</button>
                  <div class="muted small" data-gpu-gpus-cost>Coût: 0 CXT</div>
                </div>
                <div class="ram-upgrade">
                  <div class="node-row"><span>Cartes</span><span data-gpu-cards>0</span></div>
                  <button data-gpu-cards-btn>Carte +1</button>
                  <div class="muted small" data-gpu-cards-cost>Coût: 0 CXT</div>
                </div>
                <div class="ram-upgrade">
                  <div class="node-row"><span>Chunk size</span><span data-gpu-chunk-label>0</span></div>
                  <button data-gpu-chunk-btn>Chunk +1</button>
                  <div class="muted small" data-gpu-chunk-cost>Coût: 0 CXT</div>
                </div>
                <div class="ram-upgrade">
                  <div class="node-row"><span>Compression</span><span data-gpu-comp-label>0%</span></div>
                  <button data-gpu-comp-btn>Compression +1</button>
                  <div class="muted small" data-gpu-comp-cost>Coût: 0 CXT</div>
                </div>
              </div>`
            : ""
        }
        ${meta.id === "gpu" ? `<div class="gpu-grid" data-gpu-grid></div>` : ""}
      ${
        meta.coresMax
          ? `<div class="cores">
                <div class="core-list" data-cores></div>
                <button data-core>Add core</button>
              </div>`
          : ""
      }
      ${
        meta.id === "validator"
          ? `<div class="val-transfer">
              <div class="val-led" data-val-led></div>
              <div class="val-bandwidth">
                <span class="muted">Transfert</span>
                <span class="val-rate" data-val-rate>0 Mo/s</span>
              </div>
            </div>`
          : ""
      }
      ${
        meta.id === "energy"
          ? `<div class="power-section">
                <div class="power-header" data-power-block-label>Bloc 1 (0/8) · +50 W/cell</div>
                <div class="power-stacks" data-power-stacks></div>
                <div class="power-mult" data-power-mult style="display:none;">
                  <div class="node-row"><span>Multiplicateur</span><span data-mult-level>1x</span></div>
                  <button data-upgrade-mult>Upgrade Multiplicateur</button>
                  <div class="muted small" data-mult-cost></div>
                </div>
              </div>`
            : ""
        }
        ${
          meta.id === "collector" || meta.id === "ram" || meta.id === "gpu"
            ? `<div class="actions" style="display:none;"></div>`
            : `<div class="actions">
                 <button data-unlock class="ghost">Débloquer</button>
                 <button data-upgrade>Améliorer</button>
               </div>`
        }
        <div class="node-row muted"><span>État</span><span data-status>Actif</span></div>
      </div>
    `;

    const upgradeBtn = card.querySelector("[data-upgrade]");
    const unlockBtn = card.querySelector("[data-unlock]");
    const coreBtn = card.querySelector("[data-core]");
    upgradeBtn?.addEventListener("click", () => handleUpgrade(meta.id));
    unlockBtn?.addEventListener("click", () => unlockNode(meta.id));
    if (coreBtn) {
      coreBtn.addEventListener("click", () => addCore(meta.id));
    }
    if (meta.id === "ram") {
      // Pas de bouton d'amélioration générique sur la RAM : on enlève complètement le bloc actions.
      const actions = card.querySelector(".actions");
      actions?.remove();
    }
    const ramCapBtn = card.querySelector("[data-ram-cap-btn]");
    const ramFreqBtn = card.querySelector("[data-ram-freq-btn]");
    ramCapBtn?.addEventListener("click", () => upgradeRamCapacity());
    ramFreqBtn?.addEventListener("click", () => handleUpgrade("ram"));
    const gpuFreqBtn = card.querySelector("[data-gpu-freq-btn]");
    const gpuCellsBtn = card.querySelector("[data-gpu-cells-btn]");
    const gpuGpusBtn = card.querySelector("[data-gpu-gpus-btn]");
    const gpuCardsBtn = card.querySelector("[data-gpu-cards-btn]");
    const gpuChunkBtn = card.querySelector("[data-gpu-chunk-btn]");
    const gpuCompBtn = card.querySelector("[data-gpu-comp-btn]");
    gpuFreqBtn?.addEventListener("click", () => upgradeGpuFreq());
    gpuCellsBtn?.addEventListener("click", () => upgradeGpuCells());
    gpuGpusBtn?.addEventListener("click", () => upgradeGpuCount());
    gpuCardsBtn?.addEventListener("click", () => upgradeGpuCard());
    gpuChunkBtn?.addEventListener("click", () => upgradeGpuChunk());
    gpuCompBtn?.addEventListener("click", () => upgradeGpuCompression());
    card.addEventListener("pointerdown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      if (!e.target.closest(".drag-handle")) return;
      startDrag(e, meta.id);
    });
    const { outputDot, inputDot, energyDot } = bindIoDots(card, meta, {
      onStartLink: (evt, nodeId, outType) => startLink(evt, nodeId, outType),
      onShowMenu: (evt, payload) => ioMenu?.show(evt, payload),
    });
    bindings[meta.id] = {
      card,
      levelEl: card.querySelector("[data-level]"),
      rateEl: card.querySelector("[data-rate]"),
      costEl: card.querySelector("[data-cost]"),
      statusEl: card.querySelector("[data-status]"),
      utilBar: card.querySelector("[data-util-bar]"),
      utilLabel: card.querySelector("[data-util-label]"),
      upgradeBtn,
      unlockBtn,
      coreBtn,
      ramCapValue: card.querySelector("[data-ram-cap]"),
      ramFreqValue: card.querySelector("[data-ram-freq]"),
      ramCapBtn,
      ramFreqBtn,
      ramCapCost: card.querySelector("[data-ram-cap-cost]"),
      ramFreqCost: card.querySelector("[data-ram-freq-cost]"),
      ramFill: card.querySelector("[data-ram-fill]"),
      ramFillText: card.querySelector("[data-ram-fill-text]"),
      ramFillPercent: card.querySelector("[data-ram-fill-percent]"),
      ramChargeRate: card.querySelector("[data-ram-charge]"),
      ramDischargeRate: card.querySelector("[data-ram-discharge]"),
      gpuChunk: card.querySelector("[data-gpu-chunk]"),
      gpuComp: card.querySelector("[data-gpu-comp]"),
      gpuCount: card.querySelector("[data-gpu-count]"),
      gpuFreq: card.querySelector("[data-gpu-freq]"),
      gpuFreqBtn: card.querySelector("[data-gpu-freq-btn]"),
      gpuFreqCost: card.querySelector("[data-gpu-freq-cost]"),
      gpuCells: card.querySelector("[data-gpu-cells]"),
      gpuCellsBtn: card.querySelector("[data-gpu-cells-btn]"),
      gpuCellsCost: card.querySelector("[data-gpu-cells-cost]"),
      gpuGpus: card.querySelector("[data-gpu-gpus]"),
      gpuGpusBtn: card.querySelector("[data-gpu-gpus-btn]"),
      gpuGpusCost: card.querySelector("[data-gpu-gpus-cost]"),
      gpuCards: card.querySelector("[data-gpu-cards]"),
      gpuCardsBtn: card.querySelector("[data-gpu-cards-btn]"),
      gpuCardsCost: card.querySelector("[data-gpu-cards-cost]"),
      gpuChunkLabel: card.querySelector("[data-gpu-chunk-label]"),
      gpuChunkBtn: card.querySelector("[data-gpu-chunk-btn]"),
      gpuChunkCost: card.querySelector("[data-gpu-chunk-cost]"),
      gpuCompLabel: card.querySelector("[data-gpu-comp-label]"),
      gpuCompBtn: card.querySelector("[data-gpu-comp-btn]"),
      gpuCompCost: card.querySelector("[data-gpu-comp-cost]"),
      gpuData: card.querySelector("[data-gpu-data]"),
      gpuHash: card.querySelector("[data-gpu-hash]"),
      gpuGrid: card.querySelector("[data-gpu-grid]"),
      cpuHash: card.querySelector("[data-cpu-hash]"),
      cpuCoin: card.querySelector("[data-cpu-coin]"),
      coresContainer: card.querySelector("[data-cores]"),
      inputDot,
      energyDot,
      outputDot,
      energyLogo: card.querySelector("[data-energy-logo]"),
      energyBar: card.querySelector("[data-energy-bar]"),
      powerStacks: card.querySelector("[data-power-stacks]"),
      blockLabel: card.querySelector("[data-power-block-label]"),
      multWrapper: card.querySelector("[data-power-mult]"),
      multBtn: card.querySelector("[data-upgrade-mult]"),
      multCost: card.querySelector("[data-mult-cost]"),
      multLevel: card.querySelector("[data-mult-level]"),
      valLed: card.querySelector("[data-val-led]"),
      valRate: card.querySelector("[data-val-rate]"),
    };

    if (meta.id === "energy") {
      const { multBtn } = bindings[meta.id];
      multBtn?.addEventListener("click", () => upgradePowerMultiplier());
    }

    nodesContainer.appendChild(card);
    updateNodeCard(meta.id);
  });
}

function updateHud() {
  const hud = [
    ["coin", "stat-coin", "rate-coin", "CXT"],
    ["bandwidth", "stat-bandwidth", "rate-bandwidth", "Bandwidth"],
    ["hash", "stat-hash", "rate-hash", "Hash"],
    ["skill", "stat-skill", "rate-skill", "XP"],
  ];
  hud.forEach(([key, valueId, rateId, suffix]) => {
    const valueEl = document.getElementById(valueId);
    const rateEl = document.getElementById(rateId);
    const val = state.resources[key] || 0;
    if (valueEl) {
      if (key === "bandwidth") {
        valueEl.textContent = formatBandwidth(val);
      } else {
        valueEl.textContent = `${formatNumber(val)}${suffix ? ` ${suffix}` : ""}`;
      }
    }
    if (rateEl) {
      if (key === "bandwidth") {
        rateEl.textContent = formatBandwidthRate(resourceRates[key] || 0);
      } else {
        rateEl.textContent = `${formatRate(resourceRates[key] || 0)}/s`;
      }
    }
  });

  const energyValEl = document.getElementById("stat-energy");
  const energyRateEl = document.getElementById("rate-energy");
  if (energyValEl) energyValEl.textContent = `${formatNumber(energyProdRate)} W`;
  if (energyRateEl) {
    energyRateEl.textContent = formatSignedW(energyBalanceRate);
    energyRateEl.style.color = energyBalanceRate >= 0 ? "var(--good)" : "var(--danger)";
  }
}

function getNodePosition(id) {
  return state.layout?.[id] || { x: getNodeMeta(id).x, y: getNodeMeta(id).y };
}

function setNodePosition(id, pos) {
  state.layout = state.layout || {};
  state.layout[id] = pos;
  syncStore();
}

function refreshWires() {
  if (wires) {
    wires.render(state.connections, bindings);
  }
}

function updateNodeCard(id) {
  const meta = getNodeMeta(id);
  const ui = bindings[id];
  if (!ui) return;
  const level = getLevel(id);
  const unlocked = isUnlocked(id);
  const connected = !meta.input || hasInputConnection(id);
  const powered = !hasEnergyInput(meta) || hasEnergyConnection(id);
  ui.levelEl.textContent = level;
  const isEnergyOff = meta.id === "energy" && level === 0;
  ui.card.classList.toggle("locked", !unlocked && !isEnergyOff);
  if (ui.unlockBtn) ui.unlockBtn.style.display = unlocked || isEnergyOff ? "none" : "inline-flex";
  if (ui.upgradeBtn) {
    ui.upgradeBtn.style.display = unlocked || isEnergyOff ? "inline-flex" : "none";
    ui.upgradeBtn.disabled = (!unlocked && !isEnergyOff) || state.resources.coin < getUpgradeCost(id);
    ui.upgradeBtn.textContent = meta.id === "energy" && isEnergyOff ? "ALLUMER" : "Améliorer";
  }

  if (!unlocked && !isEnergyOff) {
    ui.costEl.textContent = formatUnlockCost(meta.unlock);
    ui.rateEl.textContent = meta.id === "energy" ? "0 W" : "0/s";
    ui.statusEl.textContent = "Verrouillé";
    ui.statusEl.style.color = "var(--muted)";
    return;
  }

  const hasInput = meta.input ? hasInputConnection(id) || level === 0 : true;
  const canRun = (!meta.input || connected) && powered && hasInput;

  ui.costEl.textContent = `${formatNumber(getUpgradeCost(id))} CXT`;
  const rawRate = level > 0 ? getRate(meta, level) * (meta.efficiency || 1) : 0;
  const rate =
    meta.id === "validator"
      ? level > 0
        ? formatBandwidthRate(rawRate)
        : "0 Mo/s"
      : level > 0
      ? formatRate(rawRate)
      : "0";
  if (meta.id === "energy") {
    ui.rateEl.textContent = `${rate} W`;
  } else if (meta.id === "validator") {
    ui.rateEl.textContent = rate;
  } else {
    ui.rateEl.textContent = `${rate}/s`;
  }

  if (meta.id === "gpu") {
    const metrics = nodeMetrics[id] || { actual: 0 };
    const deltaSec = lastDelta || 1;
    const hashPerSec = metrics.actual / deltaSec;
    ui.rateEl.textContent = `${formatRate(hashPerSec)}/s`;
  }

  if (meta.id === "validator") {
    if (ui.valRate) {
      ui.valRate.textContent = level > 0 ? formatBandwidthRate(rawRate) : "0 Mo/s";
    }
    if (ui.valLed) {
      ui.valLed.classList.toggle("on", canRun);
      ui.valLed.classList.toggle("off", !canRun);
    }
  }

  if (meta.id === "ram") {
    const capLevel = getRamCapLevel();
    const cap = getRamCapacity(capLevel);
    const ramState = state.nodes?.ram || {};
    const fill = clamp(ramState.fill || 0, 0, cap);
    const pct = cap > 0 ? Math.round((fill / cap) * 100) : 0;
    if (ui.ramCapValue) ui.ramCapValue.textContent = `${formatBandwidth(cap).replace("/s", "")}`;
    if (ui.ramFreqValue) ui.ramFreqValue.textContent = `Niv. ${level}`;
    if (ui.ramCapCost) ui.ramCapCost.textContent = `Coût: ${formatNumber(getRamCapCost(capLevel))} CXT`;
    if (ui.ramFreqCost) ui.ramFreqCost.textContent = `Coût: ${formatNumber(getRamFreqCost(level))} CXT`;
    if (ui.ramCapBtn) {
      ui.ramCapBtn.disabled = !unlocked || state.resources.coin < getRamCapCost(capLevel);
    }
    if (ui.ramFreqBtn) {
      ui.ramFreqBtn.disabled = !unlocked || state.resources.coin < getRamFreqCost(level);
    }
    const chargeRate = getRamChargeRate(level) * ((meta.efficiency || 1));
    const dischargeRate = getRamDischargeRate(level) * ((meta.efficiency || 1));
    if (ui.ramChargeRate) ui.ramChargeRate.textContent = formatBandwidthRate(chargeRate);
    if (ui.ramDischargeRate) ui.ramDischargeRate.textContent = formatBandwidthRate(dischargeRate);
    // On affiche le coût principal comme le coût fréquence pour cohérence (même si la ligne est masquée).
    ui.costEl.textContent = `${formatNumber(getRamFreqCost(level))} CXT`;
    if (ui.ramFill) {
      ui.ramFill.style.width = `${Math.min(100, pct)}%`;
      ui.ramFill.style.opacity = 0.35 + (pct / 100) * 0.65;
    }
    if (ui.ramFillText) ui.ramFillText.textContent = `${formatBandwidth(fill).replace("/s", "")} / ${formatBandwidth(cap).replace("/s", "")}`;
    if (ui.ramFillPercent) ui.ramFillPercent.textContent = `${pct}%`;
  }

  if (meta.id === "gpu" && (ui.gpuData || ui.gpuHash)) {
    const metrics = nodeMetrics[id] || { actual: 0 };
    const deltaSec = lastDelta || 1;
    const hashPerSec = metrics.actual / deltaSec;
    const gpuState = getGpuState();
    const chunkSizeKo = getGpuChunkSize(gpuState.chunkTier);
    const hashesPerChunk = gpuHashesPerChunk(chunkSizeKo, 1, gpuCompression(gpuState.compressionLevel));
    const chunkSizeMo = chunkSizeKo / 1024;
    const chunksPerSec = hashesPerChunk > 0 ? hashPerSec / hashesPerChunk : 0;
    const dataPerSec = chunksPerSec * chunkSizeMo;
    if (ui.gpuData) ui.gpuData.textContent = formatBandwidthRate(dataPerSec);
    if (ui.gpuHash) ui.gpuHash.textContent = `${formatRate(hashPerSec)}/s`;
    if (ui.gpuChunk) ui.gpuChunk.textContent = `${chunkSizeKo} Ko`;
    if (ui.gpuComp) ui.gpuComp.textContent = `${Math.round(gpuCompression(gpuState.compressionLevel) * 100)}%`;
    if (ui.gpuCount) ui.gpuCount.textContent = `${gpuState.gpuCount} GPU · ${gpuState.cardCount} carte(s)`;
  }

  if (meta.id === "cpu" && (ui.cpuHash || ui.cpuCoin)) {
    const metrics = nodeMetrics[id] || { actual: 0 };
    const deltaSec = lastDelta || 1;
    const hashPerSec = metrics.actual / deltaSec;
    const coinPerSec = hashPerSec; // 1 hash => 1 coin
    if (ui.cpuHash) ui.cpuHash.textContent = `${formatRate(hashPerSec)}/s`;
    if (ui.cpuCoin) ui.cpuCoin.textContent = `${formatRate(coinPerSec)}/s`;
  }

  if (meta.id === "gpu") {
    const gs = getGpuState();
    const chunkSizeKo = getGpuChunkSize(gs.chunkTier);
    const comp = gpuCompression(gs.compressionLevel);
    const freqMHz = gpuFreqMHz(1, gs.freqLevel);
    if (ui.gpuFreq) ui.gpuFreq.textContent = `${freqMHz.toFixed(2)} MHz`;
    if (ui.gpuCells) ui.gpuCells.textContent = `${gs.cellsPerGpu}`;
    if (ui.gpuGpus) ui.gpuGpus.textContent = `${gs.gpuCount} / ${gs.cardCount * 32}`;
    if (ui.gpuCards) ui.gpuCards.textContent = `${gs.cardCount} / 4`;
    if (ui.gpuChunkLabel) ui.gpuChunkLabel.textContent = `${chunkSizeKo} Ko`;
    if (ui.gpuCompLabel) ui.gpuCompLabel.textContent = `${Math.round(comp * 100)}%`;

    const freqCost = getGpuFreqCost(gs.freqLevel);
    const cellsCost = getGpuCellsCost(gs.cellsPerGpu + 1);
    const gpuCost = getGpuCountCost((gs.purchasedGpuCount || 0) + 1);
    const nextCard = gs.cardCount + 1;
    const cardCost = getGpuCardCost(nextCard);
    const nextTier = gs.chunkTier + 1;
    const chunkCost = getGpuChunkCost(nextTier);
    const compCost = getGpuCompressionCost(gs.compressionLevel + 1);
    if (ui.gpuFreqCost) ui.gpuFreqCost.textContent = `Coût: ${formatNumber(freqCost)} CXT`;
    if (ui.gpuCellsCost) ui.gpuCellsCost.textContent = `Coût: ${formatNumber(cellsCost)} CXT`;
    if (ui.gpuGpusCost) ui.gpuGpusCost.textContent = gs.gpuCount >= gs.cardCount * 32 ? "Max" : `Coût: ${formatNumber(gpuCost)} CXT`;
    if (ui.gpuCardsCost) ui.gpuCardsCost.textContent = nextCard > 4 ? "Max" : `Coût: ${formatNumber(cardCost)} CXT`;
    if (ui.gpuChunkCost) ui.gpuChunkCost.textContent = nextTier >= GPU_CHUNK_SIZES.length ? "Max" : `Coût: ${formatNumber(chunkCost)} CXT`;
    if (ui.gpuCompCost) ui.gpuCompCost.textContent = `Coût: ${formatNumber(compCost)} CXT`;

    if (ui.gpuFreqBtn) ui.gpuFreqBtn.disabled = state.resources.coin < freqCost;
    if (ui.gpuCellsBtn) ui.gpuCellsBtn.disabled = state.resources.coin < cellsCost;
    if (ui.gpuGpusBtn) ui.gpuGpusBtn.disabled = gs.gpuCount >= gs.cardCount * 32 || state.resources.coin < gpuCost;
    if (ui.gpuCardsBtn) ui.gpuCardsBtn.disabled = nextCard > 4 || state.resources.coin < cardCost;
    if (ui.gpuChunkBtn) ui.gpuChunkBtn.disabled = nextTier >= GPU_CHUNK_SIZES.length || state.resources.coin < chunkCost;
    if (ui.gpuCompBtn) ui.gpuCompBtn.disabled = state.resources.coin < compCost;

    // Ajuste le coût principal affiché pour cohérence (même si la ligne générique est masquée).
    ui.costEl.textContent = `${formatNumber(freqCost)} CXT`;
    if (ui.gpuGrid) renderGpuGrid(ui.gpuGrid, gs);
  }

  if (meta.coresMax && ui.coresContainer) {
    ui.coresContainer.innerHTML = "";
    const cores = getCores(id);
    for (let i = 0; i < meta.coresMax; i++) {
      const dot = document.createElement("div");
      dot.className = "core";
      if (i < cores) dot.classList.add("active");
      ui.coresContainer.appendChild(dot);
    }
    if (ui.coreBtn) {
      ui.coreBtn.style.display = unlocked ? "inline-flex" : "none";
      ui.coreBtn.disabled = !unlocked || cores >= meta.coresMax || state.resources.coin < getCoreCost(id);
      ui.coreBtn.textContent = cores >= meta.coresMax ? "Max cores" : `Add core (${formatNumber(getCoreCost(id))} CXT)`;
    }
  }

  if (!powered && hasEnergyInput(meta)) {
    ui.statusEl.textContent = "Pas d'énergie";
    ui.statusEl.style.color = "var(--muted)";
  } else if (!connected && meta.input) {
    ui.statusEl.textContent = "Non connecté";
    ui.statusEl.style.color = "var(--muted)";
  } else {
    ui.statusEl.textContent = canRun ? "Actif" : "En attente d'entrée";
    ui.statusEl.style.color = canRun ? "var(--good)" : "var(--danger)";
  }
  ui.card.classList.toggle("idle", !canRun);

  if (ui.utilBar && hasUtilGauge(meta)) {
    const metrics = nodeMetrics[id] || { potential: 0, actual: 0 };
    const ratio = metrics.potential > 0 ? clamp(Math.round((metrics.actual / metrics.potential) * 100), 0, 999) : 0;
    ui.utilLabel.textContent = `${ratio}%`;
    ui.utilBar.style.width = `${Math.min(ratio, 100)}%`;
    ui.utilBar.classList.toggle("low", ratio < 35);
    ui.utilBar.classList.toggle("mid", ratio >= 35 && ratio < 80);
  }

  if (meta.id === "energy") {
    updateEnergyHero(ui);
  }
}

function runProduction(delta) {
  const net = simulateProduction(delta, state, { recordMetrics: true });
  lastDelta = delta;
  const producedRate = (net.energyProduced || 0) / delta;
  const consumedRate = (net.energyConsumed || 0) / delta;
  energyProdRate = energyProdRate * 0.7 + producedRate * 0.3;
  energyBalanceRate = energyBalanceRate * 0.7 + (producedRate - consumedRate) * 0.3;
  NODES.forEach((meta) => updateNodeCard(meta.id));
  return net;
}

function simulateProduction(delta, targetState, options = {}) {
  const { recordMetrics = false } = options;
  const metrics = recordMetrics ? {} : null;
  const net = {
    coin: 0,
    hash: 0,
    bandwidth: 0,
    skill: 0,
    energy: 0,
    energyProduced: 0,
    energyConsumed: 0,
  };
  NODES.forEach((meta) => {
    const nodeState = targetState.nodes[meta.id] || {};
    const level = nodeState.level || 0;
    if (!nodeState.unlocked || level <= 0) {
      if (metrics) metrics[meta.id] = { potential: 0, actual: 0 };
      return;
    }
    const missingInputLink = meta.input && !hasInputConnection(meta.id);
    const missingEnergyLink = hasEnergyInput(meta) && !hasEnergyConnection(meta.id);
    const cores = meta.coresMax ? nodeState.cores || meta.baseCores || 0 : 1;
    const rate = getRate(meta, level) * (meta.efficiency || 1) * cores;
    const potential = rate * delta;
    let work = missingInputLink || missingEnergyLink ? 0 : potential;

    if (meta.id === "ram") {
      const capLevel = nodeState.capLevel || 1;
      const cap = getRamCapacity(capLevel);
      const currentFill = clamp(nodeState.fill || 0, 0, cap);
      const discharging = typeof nodeState.discharging === "boolean" ? nodeState.discharging : false;
      const chargeRate = getRamChargeRate(level) * (meta.efficiency || 1);
      const desiredCharge = chargeRate * delta;
      const energyUse = getEnergyUse(meta, level);
      const neededEnergy = energyUse * delta;
      const availableEnergy = targetState.resources.energy || 0;
      const energyFactor = neededEnergy > 0 ? Math.min(1, availableEnergy / neededEnergy) : 1;
      const availableBandwidth = targetState.resources.bandwidth || 0;
      const bandwidthFactor = desiredCharge > 0 ? Math.min(1, availableBandwidth / desiredCharge) : 1;
      const factor = Math.min(energyFactor, bandwidthFactor);
      let charge = desiredCharge * factor;
      const space = Math.max(0, cap - currentFill);
      if (charge > space) charge = space;
      const energyConsume = neededEnergy * (desiredCharge > 0 ? charge / desiredCharge : 0);
      const bandwidthConsume = charge;
      targetState.resources.energy = Math.max(0, availableEnergy - energyConsume);
      targetState.resources.bandwidth = Math.max(0, availableBandwidth - bandwidthConsume);
      net.energy -= energyConsume;
      net.energyConsumed += energyConsume;
      net.bandwidth -= bandwidthConsume;
      targetState.nodes.ram = { ...nodeState, fill: currentFill + charge, discharging };
      if (metrics) metrics[meta.id] = { potential: desiredCharge, actual: charge };
      return;
    }

    const energyUse = getEnergyUse(meta, level);
    if (meta.id !== "gpu" && meta.id !== "cpu") {
      if (!missingEnergyLink && energyUse && work > 0) {
        const needed = energyUse * delta;
        const available = targetState.resources.energy || 0;
        const factor = Math.min(1, needed > 0 ? available / needed : 1);
        if (factor <= 0) {
          work = 0;
        } else {
          work *= factor;
          const consumeEnergy = needed * factor;
          targetState.resources.energy = Math.max(0, available - consumeEnergy);
          net.energy -= consumeEnergy;
          net.energyConsumed += consumeEnergy;
        }
      }
    }
    if (!missingInputLink && meta.input) {
      if (meta.id === "gpu") {
        const ramState = targetState.nodes.ram || {};
        const cap = getRamCapacity(ramState.capLevel || 1);
        const fill = clamp(ramState.fill || 0, 0, cap);
        let discharging = typeof ramState.discharging === "boolean" ? ramState.discharging : false;
        if (!discharging && fill >= cap - RAM_EPS) {
          discharging = true;
        }
        if (!discharging) {
          if (metrics) metrics[meta.id] = { potential: 0, actual: 0 };
          return;
        }
        const gpuState = getGpuState(targetState);
        const chunkSizeKo = getGpuChunkSize(gpuState.chunkTier);
        const chunkSizeMo = chunkSizeKo / 1024;
        const comp = gpuCompression(gpuState.compressionLevel);
        const hashesPerChunk = gpuHashesPerChunk(chunkSizeKo, 1, comp);
        const freqMHz = gpuFreqMHz(1, gpuState.freqLevel);
        const hashCapPerSec = HASH_PER_MHZ_PER_CELL * freqMHz * gpuState.cellsPerGpu * gpuState.gpuCount;
        const desiredChunksPerSec = hashesPerChunk > 0 ? hashCapPerSec / hashesPerChunk : 0;
        const desiredMoPerSec = desiredChunksPerSec * chunkSizeMo;
        const dischargeRate = getRamDischargeRate(ramState.level || 1) * ((getNodeMeta("ram")?.efficiency || 1));
        const energyNeeded = getEnergyUse(meta, level) * delta;
        const energyAvail = targetState.resources.energy || 0;
        const energyFactor = energyNeeded > 0 ? Math.min(1, energyAvail / energyNeeded) : 1;
        const potentialMo = Math.min(fill, dischargeRate * delta, desiredMoPerSec * delta);
        const actualMo = potentialMo * energyFactor;
        const maxMo = actualMo; // alias de sécurité pour éviter les refs anciennes
        const chunksProcessed = chunkSizeMo > 0 ? actualMo / chunkSizeMo : 0;
        const hashProduced = chunksProcessed * hashesPerChunk;
        const energyConsume = energyNeeded * energyFactor;
        let nextFill = Math.max(0, fill - actualMo);
        if (nextFill <= RAM_EPS) {
          nextFill = 0;
          discharging = false;
        }
        targetState.nodes.ram = { ...ramState, fill: nextFill, discharging };
        targetState.resources.energy = Math.max(0, energyAvail - energyConsume);
        net.energy -= energyConsume;
        net.energyConsumed += energyConsume;
        targetState.resources.hash = (targetState.resources.hash || 0) + hashProduced;
        net.hash += hashProduced;
        if (metrics) metrics[meta.id] = { potential: hashCapPerSec * delta, actual: hashProduced };
        return;
      }
      if (meta.id === "cpu") {
        const cpuRatePerSec = CPU_HASH_PER_SEC_BASE * Math.pow(CPU_HASH_SCALE, level - 1) * (nodeState.cores || 1);
        const hashAvailable = targetState.resources.hash || 0;
        const energyNeeded = getEnergyUse(meta, level) * delta;
        const energyAvail = targetState.resources.energy || 0;
        const energyFactor = energyNeeded > 0 ? Math.min(1, energyAvail / energyNeeded) : 1;
        let hashCanProcess = Math.min(hashAvailable, cpuRatePerSec * delta);
        hashCanProcess = Math.min(hashCanProcess, CPU_HASH_CAP_PER_TICK * delta);
        hashCanProcess *= energyFactor;
        const energyConsume = energyNeeded * energyFactor;
        targetState.resources.energy = Math.max(0, energyAvail - energyConsume);
        targetState.resources.hash = Math.max(0, hashAvailable - hashCanProcess);
        targetState.resources.coin = (targetState.resources.coin || 0) + hashCanProcess;
        net.energy -= energyConsume;
        net.energyConsumed += energyConsume;
        net.hash -= hashCanProcess;
        net.coin += hashCanProcess;
        if (metrics) metrics[meta.id] = { potential: cpuRatePerSec * delta, actual: hashCanProcess };
        return;
      }
      const ratio = meta.inputRatio || 1;
      const available = (targetState.resources[meta.input] || 0) / ratio;
      if (available <= 0) {
        work = 0;
      } else if (work > available) {
        work = available;
      }
      const consume = work * ratio;
      targetState.resources[meta.input] = (targetState.resources[meta.input] || 0) - consume;
      net[meta.input] -= consume;
    }
    if (metrics) metrics[meta.id] = { potential, actual: work };
    targetState.resources[meta.output] = (targetState.resources[meta.output] || 0) + work;
    net[meta.output] += work;
    if (meta.output === "energy") {
      net.energyProduced += work;
    }
  });
  if (recordMetrics) {
    nodeMetrics = metrics;
  }
  return net;
}

function smoothRates(net, delta) {
  Object.keys(resourceRates).forEach((key) => {
    const perSecond = (net[key] || 0) / delta;
    resourceRates[key] = resourceRates[key] * 0.7 + perSecond * 0.3;
  });
}

function startDrag(e, id) {
  const ui = bindings[id];
  if (!ui) return;
  e.preventDefault();
  const rect = ui.card.getBoundingClientRect();
  drag = {
    id,
    offsetX: e.clientX - rect.left,
    offsetY: e.clientY - rect.top,
    width: rect.width,
    height: rect.height,
    pointerId: e.pointerId,
  };
  ui.card.setPointerCapture(e.pointerId);
  ui.card.style.zIndex = 5;
  ui.card.classList.add("dragging");
  document.addEventListener("pointermove", onDrag);
  document.addEventListener("pointerup", endDrag);
}

function onDrag(e) {
  if (!drag) return;
  const ui = bindings[drag.id];
  if (!ui) return;
  const containerRect = playfield.getBoundingClientRect();
  let x = e.clientX - containerRect.left - drag.offsetX;
  let y = e.clientY - containerRect.top - drag.offsetY;
  const maxX = containerRect.width - drag.width;
  const maxY = containerRect.height - drag.height;
  x = Math.max(0, Math.min(x, maxX));
  y = Math.max(0, Math.min(y, maxY));
  ui.card.style.left = `${x}px`;
  ui.card.style.top = `${y}px`;
  setNodePosition(drag.id, { x, y });
  refreshWires();
}

function endDrag() {
  if (!drag) return;
  const ui = bindings[drag.id];
  if (ui) {
    ui.card.classList.remove("dragging");
    ui.card.style.zIndex = "";
    if (drag.pointerId && ui.card.hasPointerCapture(drag.pointerId)) {
      ui.card.releasePointerCapture(drag.pointerId);
    }
  }
  document.removeEventListener("pointermove", onDrag);
  document.removeEventListener("pointerup", endDrag);
  syncStore();
  drag = null;
}

function startLink(e, fromId, explicitKind) {
  e.stopPropagation();
  ioMenu?.hide();
  const meta = getNodeMeta(fromId);
  if (!meta || !hasOutputAnchor(meta)) return;
  const outType = explicitKind || e.currentTarget?.dataset?.outType || meta.output || "data";
  linking = { fromId, kind: outType === "energy" ? "energy" : "data" };
  const rect = playfield.getBoundingClientRect();
  const toPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  wires.setPreview({ fromId, toPoint, kind: linking.kind });
  document.addEventListener("pointermove", onLinkMove);
  document.addEventListener("pointerup", endLink);
}

function onLinkMove(e) {
  if (!linking) return;
  const rect = playfield.getBoundingClientRect();
  const toPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  wires.setPreview({ fromId: linking.fromId, toPoint, kind: linking.kind });
}

function endLink(e) {
  if (!linking) return;
  ioMenu?.hide();
  const targetDot = e.target.closest?.(".io-dot");
  if (targetDot) {
    const toCard = targetDot.closest(".node-card");
    const toId = toCard?.dataset.node;
    const fromMeta = getNodeMeta(linking.fromId);
    const prefersEnergy = fromMeta?.output === "energy" || linking.kind === "energy";
    const kind = targetDot.dataset.io === "energy" ? "energy" : prefersEnergy ? "energy" : "data";
    tryCreateConnection(linking.fromId, toId, kind);
  }
  linking = null;
  wires.clearPreview();
  document.removeEventListener("pointermove", onLinkMove);
  document.removeEventListener("pointerup", endLink);
  refreshWires();
}

function label(resource) {
  switch (resource) {
    case "bandwidth":
      return "Bandwidth";
    case "data":
      return "Data";
    case "coin":
      return "CXT";
    case "hash":
      return "Hash";
    case "skill":
      return "XP";
    case "energy":
      return "Energy";
    default:
      return resource;
  }
}

function formatSignedW(value) {
  const abs = Math.abs(value);
  if (abs < 0.01) return "0 W";
  const formatted = abs < 1 ? abs.toFixed(2) : abs.toFixed(1);
  const prefix = value > 0 ? "+" : "-";
  return `${prefix}${formatted} W`;
}

function getEnergyLoadPercent() {
  const prod = Math.max(0, energyProdRate);
  if (prod <= 0.0001) return 0;
  const consumed = Math.max(0, prod - energyBalanceRate);
  return (consumed / prod) * 100;
}

function updateEnergyHero(ui) {
  const pct = getEnergyLoadPercent();
  const overload = pct > 100;
  if (ui.energyLogo) {
    ui.energyLogo.style.setProperty("--energy-color", overload ? "#ff5f7a" : "#ffd166");
    ui.energyLogo.classList.toggle("overload", overload);
  }
  if (ui.energyBar) {
    const width = Math.min(160, pct); // allow slight overflow for overuse
    ui.energyBar.style.width = `${width}%`;
    ui.energyBar.classList.toggle("overload", overload);
  }

  updatePowerCellsUI(ui);
}

function getPowerCellsState() {
  if (!state.powerCells) {
    state.powerCells = createDefaultPowerCells();
  }
  return state.powerCells;
}

function getEnergyOutputPerSec(level) {
  const base = NODES.find((n) => n.id === "energy")?.baseRate || 0;
  const scaledBase = base * getEnergyLevelScale(level);
  const pcState = getPowerCellsState();
  const cellsPower = POWER_CELL_BLOCKS.reduce((sum, def, idx) => sum + def.power * (pcState.blocks[idx]?.cells || 0), 0);
  const mult = (pcState.multiplier || 0) + 1;
  return (scaledBase + cellsPower) * mult;
}

function getNextPowerCellCost() {
  const pcState = getPowerCellsState();
  const currentIdx = pcState.blocks.findIndex((b) => b.unlocked && b.cells < POWER_CELLS_PER_BLOCK);
  if (currentIdx === -1) return null;
  const nextCellIndex = pcState.blocks[currentIdx].cells + 1;
  return { cost: getPowerCellCost(currentIdx, nextCellIndex), block: currentIdx };
}

function getMultiplierCost() {
  const pcState = getPowerCellsState();
  if (!pcState.blocks.every((b) => b.cells === POWER_CELLS_PER_BLOCK)) return null;
  const level = pcState.multiplier || 0;
  const cost = getPowerMultiplierCost(level);
  return { cost: Math.round(cost), level };
}

function addPowerCell(blockIndex) {
  const pcState = getPowerCellsState();
  const targetIdx =
    typeof blockIndex === "number" ? blockIndex : pcState.blocks.findIndex((b) => b.unlocked && b.cells < POWER_CELLS_PER_BLOCK);
  if (targetIdx === -1) return;
  const nextCellIndex = pcState.blocks[targetIdx].cells + 1;
  const cost = getPowerCellCost(targetIdx, nextCellIndex);
  if (state.resources.coin < cost) {
    flashHint("Pas assez de crédits");
    return;
  }
  state.resources.coin -= cost;
  pcState.blocks[targetIdx].cells = Math.min(POWER_CELLS_PER_BLOCK, pcState.blocks[targetIdx].cells + 1);
  syncStore();
  updateNodeCard("energy");
  refreshWires();
}

function unlockPowerBlock(blockIndex) {
  const pcState = getPowerCellsState();
  const prevIdx = blockIndex - 1;
  if (blockIndex <= 0 || !pcState.blocks[prevIdx] || pcState.blocks[blockIndex]?.unlocked) return;
  if (pcState.blocks[prevIdx].cells !== POWER_CELLS_PER_BLOCK) return;
  const cost = computeUnlockBlockCost(prevIdx);
  if (state.resources.coin < cost) {
    flashHint("Pas assez de crédits");
    return;
  }
  state.resources.coin -= cost;
  pcState.blocks[blockIndex].unlocked = true;
  syncStore();
  updateNodeCard("energy");
  refreshWires();
}

function upgradePowerMultiplier() {
  const info = getMultiplierCost();
  if (!info) return;
  if (state.resources.coin < info.cost) {
    flashHint("Pas assez de crédits");
    return;
  }
  state.resources.coin -= info.cost;
  const pcState = getPowerCellsState();
  pcState.multiplier = (pcState.multiplier || 0) + 1;
  syncStore();
  updateNodeCard("energy");
}

function updatePowerCellsUI(ui) {
  const pcState = getPowerCellsState();
  // Auto-unlock next block when the previous one is full
  let unlockedChanged = false;
  pcState.blocks.forEach((b, idx) => {
    if (!b.unlocked && idx > 0 && pcState.blocks[idx - 1]?.cells === POWER_CELLS_PER_BLOCK) {
      b.unlocked = true;
      unlockedChanged = true;
    }
  });
  if (unlockedChanged) {
    syncStore();
  }
  const currentBlockIdx = pcState.blocks.findIndex((b) => b.unlocked && b.cells < POWER_CELLS_PER_BLOCK);
  const activeIdx = currentBlockIdx === -1 ? pcState.blocks.length - 1 : currentBlockIdx;
  const block = pcState.blocks[activeIdx];
  const def = POWER_CELL_BLOCKS[activeIdx];

  if (ui.powerStacks) {
    ui.powerStacks.innerHTML = "";
    pcState.blocks.forEach((b, idx) => {
      const row = document.createElement("div");
      row.className = "power-row";
      if (!b.unlocked) row.classList.add("locked");
      if (idx === activeIdx) row.classList.add("active");
      if (b.cells === POWER_CELLS_PER_BLOCK) row.classList.add("full");

      const grid = document.createElement("div");
      grid.className = "power-grid";
      for (let i = 0; i < POWER_CELLS_PER_BLOCK; i++) {
        const cell = document.createElement("div");
        cell.className = "power-cell";
        if (i < b.cells) cell.classList.add("filled");
        if (b.cells === POWER_CELLS_PER_BLOCK) cell.classList.add("full");
        grid.appendChild(cell);
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "power-row-btn";

      const unlockEligible = idx > 0 && pcState.blocks[idx - 1]?.cells === POWER_CELLS_PER_BLOCK && !b.unlocked;
      if (!b.unlocked) {
        btn.classList.add("ghost");
        btn.disabled = true;
        btn.textContent = "Bloc verrouillé";
      } else if (b.cells === POWER_CELLS_PER_BLOCK) {
        btn.disabled = true;
        btn.classList.add("power-full");
        btn.innerHTML = "⚡ Super Cell";
      } else {
        const nextCellIndex = b.cells + 1;
        const cost = getPowerCellCost(idx, nextCellIndex);
        const isActive = idx === activeIdx;
        btn.disabled = !isActive || state.resources.coin < cost;
        btn.innerHTML = `Power Cell<br>(${formatNumber(cost)} CXT)`;
        btn.addEventListener("click", () => addPowerCell(idx));
      }

      row.appendChild(grid);
      row.appendChild(btn);
      ui.powerStacks.appendChild(row);
    });
  }
  if (ui.blockLabel) {
    ui.blockLabel.textContent = `Bloc ${activeIdx + 1} (${block.cells}/${POWER_CELLS_PER_BLOCK}) · +${def.power} W/cell`;
  }

  if (ui.multWrapper) {
    const allComplete = pcState.blocks.every((b) => b.cells === POWER_CELLS_PER_BLOCK);
    ui.multWrapper.style.display = allComplete ? "flex" : "none";
    if (allComplete) {
      const multCost = getMultiplierCost();
      if (ui.multLevel) ui.multLevel.textContent = `${(pcState.multiplier || 0) + 1}x`;
      if (ui.multCost) ui.multCost.textContent = multCost ? `Coût: ${formatNumber(multCost.cost)} CXT` : "";
      if (ui.multBtn) {
        ui.multBtn.disabled = !multCost || state.resources.coin < multCost.cost;
        ui.multBtn.textContent = "Upgrade Multiplicateur";
      }
    }
  }
}

function renderGpuGrid(container, gs) {
  if (!container) return;
  container.innerHTML = "";
  const cards = gs.cardCount;
  let remaining = gs.gpuCount;
  const maxPerCard = 32;
  for (let i = 0; i < cards; i++) {
    const row = document.createElement("div");
    row.className = "gpu-row";
    const grid = document.createElement("div");
    grid.className = "gpu-grid-cells";
    const countOnCard = Math.min(maxPerCard, remaining);
    for (let c = 0; c < maxPerCard; c++) {
      const cell = document.createElement("div");
      cell.className = "gpu-cell";
      if (c < countOnCard) cell.classList.add("filled");
      grid.appendChild(cell);
    }
    remaining = Math.max(0, remaining - countOnCard);
    const label = document.createElement("div");
    label.className = "gpu-row-label";
    label.textContent = `Carte ${i + 1} (${countOnCard}/${maxPerCard})`;
    row.appendChild(grid);
    row.appendChild(label);
    container.appendChild(row);
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

function disconnectConnection(conn) {
  state = cablage.remove(state, conn);
  refreshWires();
  syncStore();
  updateNodeCard(conn.from);
  updateNodeCard(conn.to);
}

function onResize() {
  refreshWires();
}
