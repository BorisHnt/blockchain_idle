import { clamp, formatNumber, formatRate, formatSeconds } from "../../app/utils.js";

export const id = "board";
export const name = "Playfield";

const LAYOUT_VERSION = 3;
const MAX_OFFLINE_SECONDS = 60 * 60 * 12; // 12h cap
const TICK_MS = 250;

const NODES = [
  {
    id: "energy",
    name: "Energy Source",
    caption: "Alimentation du réseau",
    type: "source",
    output: "energy",
    baseRate: 900,
    baseCost: 0,
    x: 80,
    y: 120,
    startLevel: 1,
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
    y: 360,
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
    unlock: { coin: 260 },
    hideOutputAnchor: true,
    x: 1460,
    y: 280,
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
let linkPreview = null;
let drag = null;
let linking = null;
let accumulator = 0;
let lastSave = performance.now();

export function createBoardState() {
  return {
    resources: { coin: 200, hash: 0, compute: 0, skill: 0, energy: 0 },
    nodes: buildDefaultNodes(),
    layout: buildDefaultLayout(),
    connections: [],
    layoutVersion: LAYOUT_VERSION,
    lastSaved: Date.now(),
  };
}

export function init({ store: appStore, bus: appBus, mountEl }) {
  store = appStore;
  bus = appBus;
  mount = mountEl;
  offlineGainEl = document.getElementById("offline-gain");
  ensureBoardState();
  renderLayout();
  applyOfflineProgress(state);
  renderNodes();
  drawConnections();
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
  const merged = {
    resources: { ...createBoardState().resources, ...(saved.resources || {}) },
    nodes: { ...baseNodes, ...(saved.nodes || {}) },
    layout:
      saved.layoutVersion === LAYOUT_VERSION ? { ...baseLayout, ...(saved.layout || {}) } : { ...baseLayout },
    connections: Array.isArray(saved.connections)
      ? saved.connections
          .filter(Boolean)
          .map((c) => ({ ...c, kind: c.kind || "resource" }))
      : [],
    layoutVersion: LAYOUT_VERSION,
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
  if (elapsed <= 0) return;
  const steps = Math.ceil(elapsed / 5); // 5s chunks
  const stepDuration = elapsed / steps;
  let gainedCoin = 0;
  for (let i = 0; i < steps; i++) {
    const net = simulateProduction(stepDuration, savedState);
    gainedCoin += net.coin > 0 ? net.coin : 0;
  }
  if (gainedCoin > 0 && offlineGainEl) {
    offlineGainEl.textContent = `+${formatNumber(gainedCoin)} CXT hors-ligne (${formatSeconds(elapsed)})`;
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
  return Math.round(meta.baseCost * Math.pow(1.22, level));
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
  const scale = Math.pow(1.18, level - 1);
  return meta.baseRate * scale;
}

function hasInputConnection(id) {
  return state.connections.some((c) => c.to === id && !isEnergyConnection(c));
}

function hasEnergyConnection(id) {
  return state.connections.some((c) => c.to === id && isEnergyConnection(c));
}

function tryCreateConnection(fromId, toId, targetType = "resource") {
  if (!fromId || !toId || fromId === toId) return;
  const fromMeta = getNodeMeta(fromId);
  const toMeta = getNodeMeta(toId);
  if (!fromMeta || !toMeta) return;
  const isEnergy = targetType === "energy";
  if (!hasOutputAnchor(fromMeta)) {
    flashHint("Connexion impossible");
    return;
  }
  if (!isUnlocked(fromId)) {
    flashHint("Débloque d'abord");
    return;
  }
  if (!isUnlocked(toId)) {
    flashHint("Débloque d'abord");
    return;
  }
  if (isEnergy) {
    if (!hasEnergyInput(toMeta)) {
      flashHint("Pas d'entrée énergie");
      return;
    }
    if (fromMeta.output !== "energy") {
      flashHint("Sortie non énergie");
      return;
    }
  } else {
    if (!hasInputAnchor(toMeta)) {
      flashHint("Ce module n'a pas d'entrée");
      return;
    }
    if (fromMeta.output !== toMeta.input) {
      flashHint("Ressources incompatibles");
      return;
    }
  }
  const exists = state.connections.some((c) => c.from === fromId && c.to === toId && c.kind === targetType);
  if (exists) {
    flashHint("Déjà connecté");
    return;
  }
  state.connections.push({ from: fromId, to: toId, kind: isEnergy ? "energy" : "resource" });
  drawConnections();
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
  drawConnections();
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
  drawConnections();
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
  drawConnections();
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
      <div class="io-group">
        <div class="flow">
          ${meta.input ? `<span class="pill input">In: ${label(meta.input)}</span>` : `<span class="pill source">Source</span>`}
          ${hasEnergyInput(meta) ? `<span class="pill energy">Power: ${meta.energyUse || 0}W</span>` : ""}
          ${hasOutputAnchor(meta) ? `<span class="pill ${meta.output === "energy" ? "energy" : "output"}">Out: ${label(meta.output)}</span>` : `<span class="pill output muted">Out: -</span>`}
        </div>
        ${
          hasInputAnchor(meta) || hasOutputAnchor(meta)
            ? `<div class="io-column">
                ${hasEnergyInput(meta) ? `<div class="io-dot energy" title="Énergie" data-io="energy"></div>` : ""}
                ${hasInputAnchor(meta) ? `<div class="io-dot input" title="Entrée" data-io="resource"></div>` : ""}
                ${hasOutputAnchor(meta) ? `<div class="io-dot ${meta.output === "energy" ? "energy" : "output"}" title="Sortie" data-io="output"></div>` : ""}
              </div>`
            : ""
        }
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
    const outputDot = card.querySelector(".io-dot.output");
    const inputDot = card.querySelector(".io-dot.input");
    if (outputDot) {
      outputDot.addEventListener("pointerdown", (e) => startLink(e, meta.id));
    }
    if (inputDot) {
      inputDot.addEventListener("pointerenter", () => inputDot.classList.add("hover"));
      inputDot.addEventListener("pointerleave", () => inputDot.classList.remove("hover"));
    }

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
      outputDot,
    };

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
    ["energy", "stat-energy", "rate-energy", "W"],
  ];
  hud.forEach(([key, valueId, rateId, suffix]) => {
    const valueEl = document.getElementById(valueId);
    const rateEl = document.getElementById(rateId);
    if (valueEl) valueEl.textContent = `${formatNumber(state.resources[key] || 0)}${suffix ? ` ${suffix}` : ""}`;
    if (rateEl) rateEl.textContent = `${formatRate(resourceRates[key] || 0)}/s`;
  });
}

function getNodePosition(id) {
  return state.layout?.[id] || { x: getNodeMeta(id).x, y: getNodeMeta(id).y };
}

function setNodePosition(id, pos) {
  state.layout = state.layout || {};
  state.layout[id] = pos;
  syncStore();
}

function getDotCenter(el) {
  if (!el) return { x: 0, y: 0 };
  const rect = el.getBoundingClientRect();
  const parent = playfield.getBoundingClientRect();
  return { x: rect.left - parent.left + rect.width / 2, y: rect.top - parent.top + rect.height / 2 };
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
    ui.rateEl.textContent = "0/s";
    ui.statusEl.textContent = "Verrouillé";
    ui.statusEl.style.color = "var(--muted)";
    return;
  }

  ui.costEl.textContent = `${formatNumber(getUpgradeCost(id))} CXT`;
  const rate = level > 0 ? formatRate(getRate(meta, level) * (meta.efficiency || 1)) : "0";
  ui.rateEl.textContent = `${rate}/s`;

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
}

function runProduction(delta) {
  const net = simulateProduction(delta, state);
  NODES.forEach((meta) => updateNodeCard(meta.id));
  return net;
}

function simulateProduction(delta, targetState) {
  const net = { coin: 0, hash: 0, compute: 0, skill: 0, energy: 0 };
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
  });
  return net;
}

function smoothRates(net, delta) {
  Object.keys(resourceRates).forEach((key) => {
    const perSecond = (net[key] || 0) / delta;
    resourceRates[key] = resourceRates[key] * 0.7 + perSecond * 0.3;
  });
}

function drawConnections() {
  const rect = playfield.getBoundingClientRect();
  wiresSvg.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
  wiresSvg.setAttribute("width", rect.width);
  wiresSvg.setAttribute("height", rect.height);
  wiresSvg.innerHTML = "";

  state.connections.forEach((conn) => {
    const from = bindings[conn.from];
    const to = bindings[conn.to];
    if (!from || !to) return;
    const fromMeta = getNodeMeta(conn.from);
    const toMeta = getNodeMeta(conn.to);
    if (!hasOutputAnchor(fromMeta) || !hasInputAnchor(toMeta)) return;
    const start = getDotCenter(from.outputDot);
    const end = getDotCenter(to.inputDot);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const midX = (start.x + end.x) / 2;
    const d = `M ${start.x} ${start.y} C ${midX} ${start.y}, ${midX} ${end.y}, ${end.x} ${end.y}`;
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke-width", "3");
    path.setAttribute("stroke-linecap", "round");
    const active = isUnlocked(conn.from) && getLevel(conn.from) > 0;
    const isEnergy = isEnergyConnection(conn);
    const color = isEnergy ? "#ffd166" : "#4dd4ff";
    path.setAttribute("stroke", active ? color : "rgba(255,255,255,0.15)");
    path.setAttribute("opacity", active ? "0.9" : "0.4");
    wiresSvg.appendChild(path);
  });

  if (linkPreview) {
    const { fromId, toPoint } = linkPreview;
    const from = bindings[fromId];
    if (from) {
      const start = getDotCenter(from.outputDot);
      const midX = (start.x + toPoint.x) / 2;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      const d = `M ${start.x} ${start.y} C ${midX} ${start.y}, ${midX} ${toPoint.y}, ${toPoint.x} ${toPoint.y}`;
      path.setAttribute("d", d);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke-width", "2");
      path.setAttribute("stroke-dasharray", "6 4");
      path.setAttribute("stroke", "rgba(77,212,255,0.8)");
      path.setAttribute("opacity", "0.8");
      wiresSvg.appendChild(path);
    }
  }
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
  drawConnections();
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

function startLink(e, fromId) {
  e.stopPropagation();
  const meta = getNodeMeta(fromId);
  if (!meta || !hasOutputAnchor(meta)) return;
  linking = { fromId };
  const rect = playfield.getBoundingClientRect();
  linkPreview = { fromId, toPoint: { x: e.clientX - rect.left, y: e.clientY - rect.top } };
  document.addEventListener("pointermove", onLinkMove);
  document.addEventListener("pointerup", endLink);
  drawConnections();
}

function onLinkMove(e) {
  if (!linking) return;
  const rect = playfield.getBoundingClientRect();
  linkPreview = { fromId: linking.fromId, toPoint: { x: e.clientX - rect.left, y: e.clientY - rect.top } };
  drawConnections();
}

function endLink(e) {
  if (!linking) return;
  const targetDot = e.target.closest?.(".io-dot");
  if (targetDot) {
    const toCard = targetDot.closest(".node-card");
    const toId = toCard?.dataset.node;
    const kind = targetDot.dataset.io === "energy" ? "energy" : "resource";
    tryCreateConnection(linking.fromId, toId, kind);
  }
  linking = null;
  linkPreview = null;
  document.removeEventListener("pointermove", onLinkMove);
  document.removeEventListener("pointerup", endLink);
  drawConnections();
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

function onResize() {
  drawConnections();
}
