import { clamp } from "../../app/utils.js";
import { createRamUI } from "./ram.ui.js";

export const id = "ram";
export const name = "RAM Cache";

const BASE_RATE = 1.4;
const COST_BASE = 200;
const COST_GROWTH = 1.2;
const ENERGY_USE = 12;

let store;
let ui;
let lastRate = 0;
let lastStatus = "Verrouillé";

export function init(context) {
  store = context.store;
  ui = createRamUI(context.mountEl, {
    onUpgrade: () => upgrade(),
  });
}

export function tick(dt) {
  store.setState((prev) => {
    const ramState = prev.modules?.ram || {};
    if (!ramState.unlocked || (ramState.level || 0) <= 0) return prev;
    const level = ramState.level || 1;
    const rate = BASE_RATE * (1 + 0.3 * (level - 1));
    const energyNeed = ENERGY_USE * dt;
    const nextResources = { ...prev.resources };
    const energyAvail = nextResources.energy || 0;
    const factor = clamp(energyNeed > 0 ? energyAvail / energyNeed : 1, 0, 1);
    const produced = rate * factor * dt;
    nextResources.energy = Math.max(0, energyAvail - energyNeed * factor);
    nextResources.compute = (nextResources.compute || 0) + produced;
    lastRate = produced / dt;
    lastStatus = factor < 0.9 ? "Limité par énergie" : "Actif";
    const nextModules = { ...prev.modules, ram: { ...ramState } };
    return { ...prev, resources: nextResources, modules: nextModules };
  });
}

export function render() {
  const state = store.getState();
  const ramState = state.modules?.[id] || {};
  const level = ramState.level || 0;
  const unlocked = ramState.unlocked || level > 0;
  const upgradeCost = getUpgradeCost(Math.max(1, level || 1));
  ui.update({
    level: Math.max(1, level || 1),
    unlocked,
    ratePerSec: lastRate,
    status: unlocked ? lastStatus : "Verrouillé",
    upgradeCost,
    canUpgrade: (state.resources.coin || 0) >= upgradeCost,
  });
}

function upgrade() {
  store.setState((prev) => {
    const ramState = prev.modules?.ram || {};
    const level = ramState.level || 0;
    const cost = getUpgradeCost(Math.max(1, level || 1));
    if ((prev.resources.coin || 0) < cost) return prev;
    const nextResources = { ...prev.resources, coin: (prev.resources.coin || 0) - cost };
    const nextLevel = level > 0 ? level + 1 : 1;
    const nextModules = {
      ...prev.modules,
      ram: { ...ramState, level: nextLevel, unlocked: true },
    };
    return { ...prev, resources: nextResources, modules: nextModules };
  });
}

function getUpgradeCost(level) {
  return Math.round(COST_BASE * Math.pow(COST_GROWTH, Math.max(0, level - 1)));
}
