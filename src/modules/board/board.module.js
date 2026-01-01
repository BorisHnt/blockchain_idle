import { clamp, formatNumber, formatRate, formatSeconds } from "../../app/utils.js";
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
const BOARD_STATE_VERSION = 3;
const MAX_OFFLINE_SECONDS = 60 * 60 * 12; // 12h cap
const TICK_MS = 250;

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
    name: "Validator Grid",
    caption: "Transforme l'énergie en compute",
    type: "source",
    output: "compute",
    energyUse: 240,
    baseRate: 4.2,
    baseCost: 60,
    x: 80,
    y: 450,
    startLevel: 1,
    startUnlocked: true,
  },
  {
    id: "gpu",
    name: "GPU Farm",
    caption: "Compute → Hash",
    input: "compute",
    output: "hash",
    energyUse: 180,
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
    energyUse: 260,
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
    id: "ram",
    name: "RAM Cache",
    caption: "Précharge les blocs, boost le hash",
    input: "compute",
    output: "hash",
    efficiency: 1.25,
    energyUse: 90,
    baseRate: 1.4,
    baseCost: 200,
    unlock: { coin: 220 },
    x: 420,
    y: 400,
    startLevel: 0,
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
    caption: "Compétences → Compute",
    input: "skill",
    output: "compute",
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
let resourceRates = { coin: 0, hash: 0, compute: 0, skill: 0, energy: 0 };
let drag = null;
let linking = null;
let accumulator = 0;
let lastSave = performance.now();
let wires;
let cablage;
let ioMenu;
let energyProdRate = 0;
let energyBalanceRate = 0;

export function createBoardState() {
  return {
    resources: { coin: 200, hash: 0, compute: 0, skill: 0, energy: 0 },
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
  const merged = {
    resources: needsReset ? createBoardState().resources : { ...createBoardState().resources, ...(saved.resources || {}) },
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
    };
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
      (isEnergyConnection(c) ? hasEnergyInput(to) : hasInputAnchor(to))
    );
  });
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
  if (meta.id === "energy") {
    return getEnergyUpgradeCost(level);
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

function getRate(meta, level) {
  if (meta.id === "energy") {
    return getEnergyOutputPerSec(level);
  }
  const scale = Math.pow(1.18, level - 1);
  return meta.baseRate * scale;
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
  if (!meta.unlock) return;
  if (!canUnlock(meta)) {
    flashHint("Conditions non remplies");
    return;
  }
  const { coin = 0, skill = 0 } = meta.unlock;
  state.resources.coin -= coin;
  state.resources.skill -= skill;
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

function renderNodes() {
  bindings = {};
  nodesContainer.innerHTML = "";
  NODES.forEach((meta) => {
    const pos = getNodePosition(meta.id);
    const card = document.createElement("div");
    card.className = "node-card";
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
      <div class="io-group">
        <div class="io-column io-column-left">
          ${hasEnergyInput(meta) ? `<div class="io-dot energy" title="Énergie" data-io="energy"></div>` : ""}
          ${hasInputAnchor(meta) ? `<div class="io-dot input" title="Entrée" data-io="data"></div>` : ""}
        </div>
        <div class="flow">
          ${meta.input ? `<span class="pill input">In: ${label(meta.input)}</span>` : `<span class="pill source">Source</span>`}
          ${hasEnergyInput(meta) ? `<span class="pill energy">Power: ${meta.energyUse || 0}W</span>` : ""}
          ${hasOutputAnchor(meta) ? `<span class="pill ${meta.output === "energy" ? "energy" : "output"}">Out: ${label(meta.output)}</span>` : `<span class="pill output muted">Out: -</span>`}
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
        <div class="node-row"><span>Coût</span><span data-cost>0</span></div>
        ${
          meta.coresMax
            ? `<div class="cores">
                <div class="core-list" data-cores></div>
                <button data-core>Add core</button>
              </div>`
            : ""
        }
        ${
          meta.id === "energy"
            ? `<div class="power-section">
                <div class="power-header" data-power-block-label>Bloc 1 (0/8) · +50 W/cell</div>
                <div class="power-grid-wrapper">
                  <div class="power-grid" data-power-grid></div>
                  <button data-add-cell class="ghost">Add Power Cell</button>
                </div>
                <button data-add-block class="ghost">Add Power Cell Block</button>
                <div class="power-mult" data-power-mult style="display:none;">
                  <div class="node-row"><span>Multiplicateur</span><span data-mult-level>1x</span></div>
                  <button data-upgrade-mult>Upgrade Multiplicateur</button>
                  <div class="muted small" data-mult-cost></div>
                </div>
              </div>`
            : ""
        }
        <div class="actions">
          <button data-unlock class="ghost">Débloquer</button>
          <button data-upgrade>Améliorer</button>
        </div>
        <div class="node-row muted"><span>État</span><span data-status>Actif</span></div>
      </div>
    `;

    const upgradeBtn = card.querySelector("[data-upgrade]");
    const unlockBtn = card.querySelector("[data-unlock]");
    const coreBtn = card.querySelector("[data-core]");
    upgradeBtn.addEventListener("click", () => handleUpgrade(meta.id));
    unlockBtn.addEventListener("click", () => unlockNode(meta.id));
    if (coreBtn) {
      coreBtn.addEventListener("click", () => addCore(meta.id));
    }
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
      upgradeBtn,
      unlockBtn,
      coreBtn,
      coresContainer: card.querySelector("[data-cores]"),
      inputDot,
      energyDot,
      outputDot,
      energyLogo: card.querySelector("[data-energy-logo]"),
      energyBar: card.querySelector("[data-energy-bar]"),
      powerGrid: card.querySelector("[data-power-grid]"),
      addCellBtn: card.querySelector("[data-add-cell]"),
      addBlockBtn: card.querySelector("[data-add-block]"),
      blockLabel: card.querySelector("[data-power-block-label]"),
      multWrapper: card.querySelector("[data-power-mult]"),
      multBtn: card.querySelector("[data-upgrade-mult]"),
      multCost: card.querySelector("[data-mult-cost]"),
      multLevel: card.querySelector("[data-mult-level]"),
    };

    if (meta.id === "energy") {
      const { addCellBtn, addBlockBtn, multBtn } = bindings[meta.id];
      addCellBtn?.addEventListener("click", () => addPowerCell());
      addBlockBtn?.addEventListener("click", () => unlockNextPowerBlock());
      multBtn?.addEventListener("click", () => upgradePowerMultiplier());
    }

    nodesContainer.appendChild(card);
    updateNodeCard(meta.id);
  });
}

function updateHud() {
  const hud = [
    ["coin", "stat-coin", "rate-coin", "CXT"],
    ["hash", "stat-hash", "rate-hash", "Hash"],
    ["compute", "stat-compute", "rate-compute", "Compute"],
    ["skill", "stat-skill", "rate-skill", "XP"],
  ];
  hud.forEach(([key, valueId, rateId, suffix]) => {
    const valueEl = document.getElementById(valueId);
    const rateEl = document.getElementById(rateId);
    if (valueEl) valueEl.textContent = `${formatNumber(state.resources[key] || 0)}${suffix ? ` ${suffix}` : ""}`;
    if (rateEl) rateEl.textContent = `${formatRate(resourceRates[key] || 0)}/s`;
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
  ui.card.classList.toggle("locked", !unlocked);
  ui.unlockBtn.style.display = unlocked ? "none" : "inline-flex";
  ui.upgradeBtn.style.display = unlocked ? "inline-flex" : "none";
  ui.unlockBtn.disabled = unlocked || !canUnlock(meta);
  ui.upgradeBtn.disabled = !unlocked || state.resources.coin < getUpgradeCost(id);

  if (!unlocked) {
    ui.costEl.textContent = formatUnlockCost(meta.unlock);
    ui.rateEl.textContent = meta.id === "energy" ? "0 W" : "0/s";
    ui.statusEl.textContent = "Verrouillé";
    ui.statusEl.style.color = "var(--muted)";
    return;
  }

  ui.costEl.textContent = `${formatNumber(getUpgradeCost(id))} CXT`;
  const rawRate = level > 0 ? getRate(meta, level) * (meta.efficiency || 1) : 0;
  const rate = level > 0 ? formatRate(rawRate) : "0";
  ui.rateEl.textContent = meta.id === "energy" ? `${rate} W` : `${rate}/s`;

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

  const hasInput = meta.input ? state.resources[meta.input] > 0 || level === 0 : true;
  const canRun = (!meta.input || connected) && powered && hasInput;
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

  if (meta.id === "energy") {
    updateEnergyHero(ui);
  }
}

function runProduction(delta) {
  const net = simulateProduction(delta, state);
  const producedRate = (net.energyProduced || 0) / delta;
  const consumedRate = (net.energyConsumed || 0) / delta;
  energyProdRate = energyProdRate * 0.7 + producedRate * 0.3;
  energyBalanceRate = energyBalanceRate * 0.7 + (producedRate - consumedRate) * 0.3;
  NODES.forEach((meta) => updateNodeCard(meta.id));
  return net;
}

function simulateProduction(delta, targetState) {
  const net = { coin: 0, hash: 0, compute: 0, skill: 0, energy: 0, energyProduced: 0, energyConsumed: 0 };
  NODES.forEach((meta) => {
    const nodeState = targetState.nodes[meta.id] || {};
    const level = nodeState.level || 0;
    if (!nodeState.unlocked || level <= 0) return;
    if (meta.input && !hasInputConnection(meta.id)) {
      return;
    }
    if (hasEnergyInput(meta) && !hasEnergyConnection(meta.id)) {
      return;
    }
    const cores = meta.coresMax ? nodeState.cores || meta.baseCores || 0 : 1;
    const rate = getRate(meta, level) * (meta.efficiency || 1) * cores;
    let work = rate * delta;
    if (meta.energyUse) {
      const needed = meta.energyUse * delta;
      const available = targetState.resources.energy || 0;
      const factor = Math.min(1, needed > 0 ? available / needed : 1);
      if (factor <= 0) return;
      work *= factor;
      const consumeEnergy = needed * factor;
      targetState.resources.energy = Math.max(0, available - consumeEnergy);
      net.energy -= consumeEnergy;
      net.energyConsumed += consumeEnergy;
    }
    if (meta.input) {
      const ratio = meta.inputRatio || 1;
      const available = (targetState.resources[meta.input] || 0) / ratio;
      if (available <= 0) {
        return;
      }
      if (work > available) {
        work = available;
      }
      const consume = work * ratio;
      targetState.resources[meta.input] = (targetState.resources[meta.input] || 0) - consume;
      net[meta.input] -= consume;
    }
    targetState.resources[meta.output] = (targetState.resources[meta.output] || 0) + work;
    net[meta.output] += work;
    if (meta.output === "energy") {
      net.energyProduced += work;
    }
  });
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
    case "coin":
      return "CXT";
    case "hash":
      return "Hash";
    case "compute":
      return "Compute";
    case "skill":
      return "XP";
    case "energy":
      return "W";
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

function getUnlockNextBlockCost() {
  const pcState = getPowerCellsState();
  const nextBlockIdx = pcState.blocks.findIndex((b, idx) => !b.unlocked && pcState.blocks[idx - 1]?.cells === POWER_CELLS_PER_BLOCK);
  if (nextBlockIdx <= 0) return null;
  return { cost: computeUnlockBlockCost(nextBlockIdx - 1), block: nextBlockIdx };
}

function getMultiplierCost() {
  const pcState = getPowerCellsState();
  if (!pcState.blocks.every((b) => b.cells === POWER_CELLS_PER_BLOCK)) return null;
  const level = pcState.multiplier || 0;
  const cost = getPowerMultiplierCost(level);
  return { cost: Math.round(cost), level };
}

function addPowerCell() {
  const next = getNextPowerCellCost();
  if (!next) return;
  if (state.resources.coin < next.cost) {
    flashHint("Pas assez de crédits");
    return;
  }
  state.resources.coin -= next.cost;
  const pcState = getPowerCellsState();
  pcState.blocks[next.block].cells = Math.min(POWER_CELLS_PER_BLOCK, pcState.blocks[next.block].cells + 1);
  syncStore();
  updateNodeCard("energy");
  refreshWires();
}

function unlockNextPowerBlock() {
  const info = getUnlockNextBlockCost();
  if (!info) return;
  if (state.resources.coin < info.cost) {
    flashHint("Pas assez de crédits");
    return;
  }
  state.resources.coin -= info.cost;
  const pcState = getPowerCellsState();
  pcState.blocks[info.block].unlocked = true;
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
  if (!ui.powerGrid) return;
  const pcState = getPowerCellsState();
  const currentBlockIdx = pcState.blocks.findIndex((b) => b.unlocked && b.cells < POWER_CELLS_PER_BLOCK);
  const activeIdx = currentBlockIdx === -1 ? pcState.blocks.length - 1 : currentBlockIdx;
  const block = pcState.blocks[activeIdx];
  const def = POWER_CELL_BLOCKS[activeIdx];

  ui.powerGrid.innerHTML = "";
  for (let i = 0; i < POWER_CELLS_PER_BLOCK; i++) {
    const cell = document.createElement("div");
    cell.className = "power-cell";
    if (i < block.cells) cell.classList.add("filled");
    if (block.cells === POWER_CELLS_PER_BLOCK) cell.classList.add("full");
    ui.powerGrid.appendChild(cell);
  }
  const nextCell = getNextPowerCellCost();
  if (ui.addCellBtn) {
    if (nextCell) {
      ui.addCellBtn.disabled = state.resources.coin < nextCell.cost;
      ui.addCellBtn.textContent = `Add Power Cell (${formatNumber(nextCell.cost)} CXT)`;
      ui.addCellBtn.classList.toggle("power-full", false);
    } else {
      ui.addCellBtn.disabled = true;
      ui.addCellBtn.textContent = "Block complet";
      ui.addCellBtn.classList.toggle("power-full", true);
    }
  }
  if (ui.blockLabel) {
    ui.blockLabel.textContent = `Bloc ${activeIdx + 1} (${block.cells}/${POWER_CELLS_PER_BLOCK}) · +${def.power} W/cell`;
  }
  const unlockInfo = getUnlockNextBlockCost();
  if (ui.addBlockBtn) {
    if (unlockInfo) {
      ui.addBlockBtn.disabled = state.resources.coin < unlockInfo.cost;
      ui.addBlockBtn.textContent = `Add Power Cell Block (${formatNumber(unlockInfo.cost)} CXT)`;
    } else {
      const allUnlocked = pcState.blocks.every((b) => b.unlocked);
      ui.addBlockBtn.disabled = true;
      ui.addBlockBtn.textContent = allUnlocked ? "Tous les blocs débloqués" : "Bloc verrouillé";
    }
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
