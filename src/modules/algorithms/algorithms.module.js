import { createAlgorithmsUI } from "./algorithms.ui.js";

export const id = "algorithms";
export const name = "Algo Optimizer";

const COST_BASE = 260;
const COST_GROWTH = 1.22;

let store;
let bus;
let ui;
let multiplier = 1;

export function init(context) {
  store = context.store;
  bus = context.bus;
  ui = createAlgorithmsUI(context.mountEl, {
    onUpgrade: () => upgrade(),
  });
}

export function tick() {
  const state = store.getState();
  const algoState = state.modules?.[id] || {};
  const level = algoState.level || 0;
  const unlocked = algoState.unlocked || level > 0;
  const nextMultiplier = unlocked ? 1 + 0.08 * Math.max(0, level - 1) : 1;
  if (Math.abs(nextMultiplier - multiplier) > 0.001) {
    multiplier = nextMultiplier;
    bus.emit("algorithms:update", { multiplier });
  }
}

export function render() {
  const state = store.getState();
  const algoState = state.modules?.[id] || {};
  const level = algoState.level || 0;
  const unlocked = algoState.unlocked || level > 0;
  const cost = getUpgradeCost(Math.max(1, level || 1));
  ui.update({
    level: Math.max(1, level || 1),
    unlocked,
    multiplier: multiplier,
    cost,
    canUpgrade: (state.resources.coin || 0) >= cost,
  });
}

function upgrade() {
  store.setState((prev) => {
    const algoState = prev.modules?.[id] || {};
    const level = algoState.level || 0;
    const cost = getUpgradeCost(Math.max(1, level || 1));
    if ((prev.resources.coin || 0) < cost) return prev;
    const nextResources = { ...prev.resources, coin: (prev.resources.coin || 0) - cost };
    const nextLevel = level > 0 ? level + 1 : 1;
    const nextModules = {
      ...prev.modules,
      [id]: { ...algoState, level: nextLevel, unlocked: true },
    };
    return { ...prev, resources: nextResources, modules: nextModules };
  });
}

function getUpgradeCost(level) {
  return Math.round(COST_BASE * Math.pow(COST_GROWTH, Math.max(0, level - 1)));
}
