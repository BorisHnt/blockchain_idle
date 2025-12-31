import { clamp } from "../../app/utils.js";
import { createRndUI } from "./rnd.ui.js";

export const id = "rnd";
export const name = "R&D Lab";

const BASE_RATE = 0.35;
const COST_BASE = 180;
const COST_GROWTH = 1.18;
const ENERGY_USE = 8;
const COIN_RATIO = 2.5;

let store;
let ui;
let lastRate = 0;
let lastStatus = "Verrouillé";

export function init(context) {
  store = context.store;
  ui = createRndUI(context.mountEl, {
    onUpgrade: () => upgrade(),
  });
}

export function tick(dt) {
  store.setState((prev) => {
    const rndState = prev.modules?.rnd || {};
    if (!rndState.unlocked || (rndState.level || 0) <= 0) return prev;
    const level = rndState.level || 1;
    const rate = BASE_RATE * (1 + 0.25 * (level - 1));
    const energyNeed = ENERGY_USE * dt;
    const coinNeed = rate * COIN_RATIO * dt;
    const nextResources = { ...prev.resources };
    const energyAvail = nextResources.energy || 0;
    const coinAvail = nextResources.coin || 0;
    const factor = clamp(
      Math.min(
        energyNeed > 0 ? energyAvail / energyNeed : 1,
        coinNeed > 0 ? coinAvail / coinNeed : 1
      ),
      0,
      1
    );
    const produced = rate * factor * dt;
    nextResources.energy = Math.max(0, energyAvail - energyNeed * factor);
    nextResources.coin = Math.max(0, coinAvail - coinNeed * factor);
    nextResources.skill = (nextResources.skill || 0) + produced;
    lastRate = produced / dt;
    lastStatus = factor < 0.8 ? "Limité par ressources" : "Actif";
    const nextModules = { ...prev.modules, rnd: { ...rndState } };
    return { ...prev, resources: nextResources, modules: nextModules };
  });
}

export function render() {
  const state = store.getState();
  const rndState = state.modules?.[id] || {};
  const level = rndState.level || 0;
  const unlocked = rndState.unlocked || level > 0;
  const cost = getUpgradeCost(Math.max(1, level || 1));
  ui.update({
    level: Math.max(1, level || 1),
    unlocked,
    ratePerSec: lastRate,
    status: unlocked ? lastStatus : "Verrouillé",
    cost,
    canUpgrade: (state.resources.coin || 0) >= cost,
  });
}

function upgrade() {
  store.setState((prev) => {
    const rndState = prev.modules?.rnd || {};
    const level = rndState.level || 0;
    const cost = getUpgradeCost(Math.max(1, level || 1));
    if ((prev.resources.coin || 0) < cost) return prev;
    const nextResources = { ...prev.resources, coin: (prev.resources.coin || 0) - cost };
    const nextLevel = level > 0 ? level + 1 : 1;
    const nextModules = {
      ...prev.modules,
      rnd: { ...rndState, level: nextLevel, unlocked: true },
    };
    return { ...prev, resources: nextResources, modules: nextModules };
  });
}

function getUpgradeCost(level) {
  return Math.round(COST_BASE * Math.pow(COST_GROWTH, Math.max(0, level - 1)));
}
