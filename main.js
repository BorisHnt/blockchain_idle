const STORAGE_KEY = "idle-techno-save-v2";
const MAX_OFFLINE_SECONDS = 60 * 60 * 12; // 12h cap
const TICK_MS = 250;

const NODES = [
  {
    id: "power",
    name: "Power Grid",
    caption: "Génère du compute stable",
    type: "source",
    output: "compute",
    baseRate: 4.2,
    baseCost: 60,
    x: 120,
    y: 340,
    startLevel: 1,
    startUnlocked: true,
  },
  {
    id: "gpu",
    name: "GPU Farm",
    caption: "Compute → Hash",
    input: "compute",
    output: "hash",
    baseRate: 2.3,
    baseCost: 120,
    x: 320,
    y: 240,
    startLevel: 1,
    startUnlocked: true,
  },
  {
    id: "cpu",
    name: "CPU Miner",
    caption: "Hash → Crédits",
    input: "hash",
    output: "coin",
    baseRate: 1.1,
    baseCost: 140,
    x: 520,
    y: 240,
    startLevel: 1,
    startUnlocked: true,
  },
  {
    id: "ram",
    name: "RAM Cache",
    caption: "Précharge les blocs, boost le hash",
    input: "compute",
    output: "hash",
    efficiency: 1.25,
    baseRate: 1.4,
    baseCost: 200,
    unlock: { coin: 220 },
    x: 320,
    y: 420,
    startLevel: 0,
  },
  {
    id: "optimizer",
    name: "Algo Optimizer",
    caption: "Hash → Crédits optimisés",
    input: "hash",
    output: "coin",
    efficiency: 1.35,
    baseRate: 0.9,
    baseCost: 260,
    unlock: { coin: 320, skill: 2 },
    x: 520,
    y: 420,
  },
  {
    id: "lab",
    name: "R&D Lab",
    caption: "Crédits → Compétences",
    input: "coin",
    output: "skill",
    baseRate: 0.35,
    baseCost: 180,
    unlock: { coin: 180 },
    x: 720,
    y: 260,
  },
  {
    id: "firmware",
    name: "Firmware Uploader",
    caption: "Compétences → Compute",
    input: "skill",
    output: "compute",
    baseRate: 0.8,
    baseCost: 240,
    unlock: { coin: 400, skill: 1 },
    x: 720,
    y: 430,
  },
];

const CONNECTIONS = [
  { from: "power", to: "gpu" },
  { from: "power", to: "ram" },
  { from: "gpu", to: "cpu" },
  { from: "ram", to: "cpu" },
  { from: "gpu", to: "optimizer" },
  { from: "optimizer", to: "lab" },
  { from: "cpu", to: "lab" },
  { from: "lab", to: "firmware" },
  { from: "firmware", to: "gpu" },
];

const DEFAULT_STATE = {
  resources: { coin: 200, hash: 0, compute: 0, skill: 0 },
  nodes: buildDefaultNodes(),
  layout: buildDefaultLayout(),
  lastSaved: Date.now(),
};

const state = loadState();
const bindings = {};
const resourceRates = { coin: 0, hash: 0, compute: 0, skill: 0 };
const playfield = document.getElementById("playfield");
const nodesContainer = document.getElementById("nodes");
const wiresSvg = document.getElementById("wires");
const offlineGainEl = document.getElementById("offline-gain");

renderNodes();
drawConnections();
updateHud();

let lastTick = performance.now();
let lastSave = performance.now();

setInterval(() => {
  const now = performance.now();
  const delta = (now - lastTick) / 1000;
  lastTick = now;
  const net = runProduction(delta);
  smoothRates(net, delta);
  updateHud();

  if (now - lastSave > 1500) {
    saveState();
    lastSave = now;
  }
}, TICK_MS);

window.addEventListener("resize", () => {
  drawConnections();
});

document.getElementById("save-btn").addEventListener("click", () => {
  saveState();
  flashHint("Sauvegardé");
});

document.getElementById("reset-btn").addEventListener("click", () => {
  if (confirm("Supprimer la sauvegarde et repartir de zéro ?")) {
    localStorage.removeItem(STORAGE_KEY);
    location.reload();
  }
});

function buildDefaultNodes() {
  return NODES.reduce((acc, meta) => {
    const level = meta.startLevel || 0;
    acc[meta.id] = { level, unlocked: meta.startUnlocked || level > 0 };
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

function loadState() {
  const baseNodes = buildDefaultNodes();
  const baseLayout = buildDefaultLayout();
  const baseState = {
    resources: { ...DEFAULT_STATE.resources },
    nodes: baseNodes,
    layout: baseLayout,
    lastSaved: Date.now(),
  };
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return baseState;
  try {
    const parsed = JSON.parse(raw);
    const merged = {
      resources: { ...DEFAULT_STATE.resources, ...parsed.resources },
      nodes: { ...baseNodes, ...parsed.nodes },
      layout: { ...baseLayout, ...(parsed.layout || {}) },
      lastSaved: parsed.lastSaved || Date.now(),
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
      };
    });
    applyOfflineProgress(merged);
    return merged;
  } catch (e) {
    console.warn("Save corrompue, reset", e);
    return baseState;
  }
}

function saveState() {
  state.lastSaved = Date.now();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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
  if (gainedCoin > 0) {
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

function getRate(meta, level) {
  const scale = Math.pow(1.18, level - 1);
  return meta.baseRate * scale;
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
}

function renderNodes() {
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
      <div class="flow">
        ${meta.input ? `<span class="pill input">In: ${label(meta.input)}</span>` : `<span class="pill source">Source</span>`}
        <span class="pill output">Out: ${label(meta.output)}</span>
      </div>
      <div class="node-body">
        <div class="node-row"><span>Production</span><span class="node-rate" data-rate>0/s</span></div>
        <div class="node-row"><span>Coût</span><span data-cost>0</span></div>
        <div class="actions">
          <button data-unlock class="ghost">Débloquer</button>
          <button data-upgrade>Améliorer</button>
        </div>
        <div class="node-row muted"><span>État</span><span data-status>Actif</span></div>
      </div>
    `;

    const upgradeBtn = card.querySelector("[data-upgrade]");
    const unlockBtn = card.querySelector("[data-unlock]");
    upgradeBtn.addEventListener("click", () => handleUpgrade(meta.id));
    unlockBtn.addEventListener("click", () => unlockNode(meta.id));
    card.addEventListener("pointerdown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      if (!e.target.closest(".drag-handle") && e.currentTarget !== card) return;
      startDrag(e, meta.id);
    });

    bindings[meta.id] = {
      card,
      levelEl: card.querySelector("[data-level]"),
      rateEl: card.querySelector("[data-rate]"),
      costEl: card.querySelector("[data-cost]"),
      statusEl: card.querySelector("[data-status]"),
      upgradeBtn,
      unlockBtn,
    };

    nodesContainer.appendChild(card);
    updateNodeCard(meta.id);
  });
}

function updateHud() {
  document.getElementById("stat-coin").textContent = `${formatNumber(state.resources.coin)} CXT`;
  document.getElementById("stat-hash").textContent = formatNumber(state.resources.hash);
  document.getElementById("stat-compute").textContent = formatNumber(state.resources.compute);
  document.getElementById("stat-skill").textContent = formatNumber(state.resources.skill);
  document.getElementById("rate-coin").textContent = `${formatRate(resourceRates.coin)}/s`;
  document.getElementById("rate-hash").textContent = `${formatRate(resourceRates.hash)}/s`;
  document.getElementById("rate-compute").textContent = `${formatRate(resourceRates.compute)}/s`;
  document.getElementById("rate-skill").textContent = `${formatRate(resourceRates.skill)}/s`;
}

function getNodePosition(id) {
  return state.layout?.[id] || { x: getNodeMeta(id).x, y: getNodeMeta(id).y };
}

function setNodePosition(id, pos) {
  state.layout = state.layout || {};
  state.layout[id] = pos;
}

function updateNodeCard(id) {
  const meta = getNodeMeta(id);
  const ui = bindings[id];
  if (!ui) return;
  const level = getLevel(id);
  const unlocked = isUnlocked(id);
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

  const hasInput = meta.input ? state.resources[meta.input] > 0 || level === 0 : true;
  ui.statusEl.textContent = hasInput ? "Actif" : "En attente d'entrée";
  ui.statusEl.style.color = hasInput ? "var(--good)" : "var(--danger)";
  ui.card.classList.toggle("idle", !hasInput);
}

function runProduction(delta) {
  const net = simulateProduction(delta, state);
  NODES.forEach((meta) => updateNodeCard(meta.id));
  return net;
}

function simulateProduction(delta, targetState) {
  const net = { coin: 0, hash: 0, compute: 0, skill: 0 };
  NODES.forEach((meta) => {
    const nodeState = targetState.nodes[meta.id] || {};
    const level = nodeState.level || 0;
    if (!nodeState.unlocked || level <= 0) return;
    const rate = getRate(meta, level) * (meta.efficiency || 1);
    let work = rate * delta;
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

  CONNECTIONS.forEach((conn) => {
    const from = bindings[conn.from];
    const to = bindings[conn.to];
    if (!from || !to) return;
    const fromRect = from.card.getBoundingClientRect();
    const toRect = to.card.getBoundingClientRect();
    const offsetX = rect.left;
    const offsetY = rect.top;
    const startX = fromRect.right - offsetX;
    const startY = fromRect.top + fromRect.height / 2 - offsetY;
    const endX = toRect.left - offsetX;
    const endY = toRect.top + toRect.height / 2 - offsetY;
    const midX = (startX + endX) / 2;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const d = `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`;
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke-width", "3");
    path.setAttribute("stroke-linecap", "round");
    const active = isUnlocked(conn.from) && getLevel(conn.from) > 0;
    path.setAttribute("stroke", active ? "#4dd4ff" : "rgba(255,255,255,0.15)");
    path.setAttribute("opacity", active ? "0.9" : "0.4");
    wiresSvg.appendChild(path);
  });
}

let drag = null;

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
  saveState();
  drag = null;
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
    default:
      return resource;
  }
}

function formatNumber(value) {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 10_000) return `${(value / 1000).toFixed(1)}k`;
  return value.toFixed(0);
}

function formatRate(value) {
  if (Math.abs(value) < 0.01) return "0";
  if (Math.abs(value) < 1) return value.toFixed(2);
  return value.toFixed(1);
}

function formatSeconds(sec) {
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  if (hours > 0) return `${hours}h${minutes.toString().padStart(2, "0")}`;
  return `${minutes}min`;
}

function flashHint(text) {
  const el = document.getElementById("save-hint");
  el.textContent = text;
  el.style.color = "var(--accent)";
  setTimeout(() => {
    el.textContent = "Auto-sauvegarde locale";
    el.style.color = "var(--muted)";
  }, 1200);
}
