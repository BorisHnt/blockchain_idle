import { clamp } from "../../app/utils.js";
import { createGpuUI } from "./gpu.ui.js";

export const id = "gpu";
export const name = "GPU Farm";

const BASE_RATE = 2.3;
const COST_BASE = 120;
const COST_GROWTH = 1.22;

let store;
let bus;
let ui;
let coolingEffect = 1;
let lastStatus = "Actif";
let lastRate = 0;
let lastUsage = { compute: 0, energy: 0 };
let algoBoost = 1;

export function init(context) {
  store = context.store;
  bus = context.bus;
  ui = createGpuUI(context.mountEl, {
    onUpgrade: () => upgrade(),
  });
  bus.on("cooling:update", (payload) => {
    if (!payload) return;
    coolingEffect = clamp(payload.gpuModifier ?? payload.efficiency ?? 1, 0.5, 1.3);
  });
  bus.on("algorithms:update", (payload) => {
    if (!payload) return;
    algoBoost = clamp(payload.multiplier || 1, 0.5, 3);
  });
}

export function tick(dt) {
  store.setState((prev) => {
    const gpuState = prev.modules?.gpu || {};
    if (!gpuState.unlocked) return prev;
    const level = gpuState.level || 1;
    const baseRate = BASE_RATE * Math.pow(1.16, level - 1) * algoBoost;
    const throttle = coolingEffect > 1 ? 1 + (coolingEffect - 1) * 0.15 : coolingEffect;
    const targetRate = baseRate * throttle;
    const computeNeed = targetRate * 0.8 * dt;
    const energyNeed = (28 + level * 6) * dt;
    const nextResources = { ...prev.resources };
    const computeAvail = nextResources.compute || 0;
    const energyAvail = nextResources.energy || 0;
    const factor = clamp(
      Math.min(
        computeNeed > 0 ? computeAvail / computeNeed : 1,
        energyNeed > 0 ? energyAvail / energyNeed : 1
      ),
      0,
      1
    );
    const producedHash = targetRate * factor * dt;
    nextResources.compute = computeAvail - computeNeed * factor;
    nextResources.energy = Math.max(0, energyAvail - energyNeed * factor);
    nextResources.hash = (nextResources.hash || 0) + producedHash;
    lastRate = producedHash / dt;
    lastUsage = {
      compute: computeNeed * factor / dt,
      energy: energyNeed * factor / dt,
    };
    lastStatus = factor < 0.8 ? "Limité par ressources" : "Actif";
    const nextModules = {
      ...prev.modules,
      gpu: { ...gpuState, throttle },
    };
    return { ...prev, resources: nextResources, modules: nextModules };
  });
}

export function render() {
  const state = store.getState();
  const gpuState = state.modules?.[id] || {};
  ui.update({
    level: gpuState.level || 1,
    unlocked: gpuState.unlocked !== false,
    ratePerSec: lastRate,
    computeUse: lastUsage.compute,
    energyUse: lastUsage.energy,
    status: lastStatus,
    throttle: coolingEffect,
    upgradeCost: getUpgradeCost(gpuState.level || 1),
    canUpgrade: (state.resources.coin || 0) >= getUpgradeCost(gpuState.level || 1),
  });
}

function upgrade() {
  store.setState((prev) => {
    const gpuState = prev.modules?.gpu || {};
    const cost = getUpgradeCost(gpuState.level || 1);
    if ((prev.resources.coin || 0) < cost) return prev;
    const nextResources = { ...prev.resources, coin: (prev.resources.coin || 0) - cost };
    const nextModules = { ...prev.modules, gpu: { ...gpuState, level: (gpuState.level || 1) + 1, unlocked: true } };
    return { ...prev, resources: nextResources, modules: nextModules };
  });
}

function getUpgradeCost(level) {
  return Math.round(COST_BASE * Math.pow(COST_GROWTH, Math.max(0, level - 1)));
}
