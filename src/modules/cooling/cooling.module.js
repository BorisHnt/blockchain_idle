import { clamp } from "../../app/utils.js";
import { createCoolingUI } from "./cooling.ui.js";

export const id = "cooling";
export const name = "Cooling";

const COST_BASE = 110;
const COST_GROWTH = 1.2;

let store;
let bus;
let ui;
let lastPayload = { efficiency: 1, overheatRisk: 0 };

export function init(context) {
  store = context.store;
  bus = context.bus;
  ui = createCoolingUI(context.mountEl, {
    onUpgrade: () => upgrade(),
  });
  emitCooling();
}

export function tick() {
  emitCooling();
}

export function render() {
  const state = store.getState();
  const coolingState = state.modules?.[id] || {};
  const level = coolingState.level || 1;
  const efficiency = computeEfficiency(level);
  const cost = getUpgradeCost(level);
  ui.update({
    level,
    efficiency,
    overheatRisk: lastPayload.overheatRisk || 0,
    canUpgrade: (state.resources.coin || 0) >= cost,
    cost,
  });
}

function emitCooling() {
  const state = store?.getState?.();
  if (!state) return;
  const coolingState = state.modules?.[id] || {};
  const level = coolingState.level || 1;
  const efficiency = computeEfficiency(level);
  const payload = {
    efficiency,
    cpuModifier: efficiency,
    gpuModifier: efficiency,
    overheatRisk: efficiency < 0.9 ? 1 - efficiency : 0,
  };
  const changed =
    Math.abs((lastPayload.efficiency || 0) - payload.efficiency) > 0.005 ||
    Math.abs((lastPayload.overheatRisk || 0) - payload.overheatRisk) > 0.005;
  if (changed) {
    lastPayload = payload;
    bus.emit("cooling:update", payload);
  }
}

function upgrade() {
  store.setState((prev) => {
    const coolingState = prev.modules?.[id] || {};
    const cost = getUpgradeCost(coolingState.level || 1);
    if ((prev.resources.coin || 0) < cost) return prev;
    const nextResources = { ...prev.resources, coin: (prev.resources.coin || 0) - cost };
    const nextModules = { ...prev.modules, [id]: { ...coolingState, level: (coolingState.level || 1) + 1 } };
    return { ...prev, resources: nextResources, modules: nextModules };
  });
}

function computeEfficiency(level) {
  return clamp(0.85 + 0.08 * Math.max(0, level - 1), 0.6, 1.35);
}

function getUpgradeCost(level) {
  return Math.round(COST_BASE * Math.pow(COST_GROWTH, Math.max(0, level - 1)));
}
