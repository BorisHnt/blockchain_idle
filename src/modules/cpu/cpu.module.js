import { clamp } from "../../app/utils.js";
import { createCpuUI } from "./cpu.ui.js";

export const id = "cpu";
export const name = "CPU Miner";

const BASE_RATE = 1.1;
const COST_BASE = 140;
const COST_GROWTH = 1.24;
const CORE_COST = 120;
const CORE_GROWTH = 1.35;
const MAX_CORES = 8;

let store;
let bus;
let ui;
let coolingEffect = 1;
let algoBoost = 1;
let lastSnapshot = {
  ratePerSec: 0,
  hashUsePerSec: 0,
  status: "Actif",
  heat: 0,
  throttle: 1,
};

export function init(context) {
  store = context.store;
  bus = context.bus;
  ui = createCpuUI(context.mountEl, {
    onUpgrade: () => upgrade(),
    onAddCore: () => addCore(),
  });
  bus.on("cooling:update", (payload) => {
    if (!payload) return;
    coolingEffect = clamp(payload.cpuModifier ?? payload.efficiency ?? 1, 0.4, 1.4);
  });
  bus.on("algorithms:update", (payload) => {
    if (!payload) return;
    algoBoost = clamp(payload.multiplier || 1, 0.5, 3);
  });
}

export function tick(dt) {
  let tickCoin = 0;
  let tickHashUse = 0;
  store.setState((prev) => {
    const cpuState = prev.modules?.cpu || {};
    if (!cpuState.unlocked) return prev;
    const level = cpuState.level || 1;
    const cores = clamp(cpuState.cores || 1, 1, MAX_CORES);
    const baseRate = BASE_RATE * Math.pow(1.18, level - 1) * cores * algoBoost;
    const heatGain = (baseRate * 0.35 + (1 - coolingEffect) * 18) * dt;
    const heatLoss = (6 * coolingEffect) * dt;
    let heat = clamp((cpuState.heat || 0) + heatGain - heatLoss, 0, 120);
    let throttle = clamp(coolingEffect, 0.35, 1.2);
    if (heat > 90) throttle *= 0.55;
    else if (heat > 70) throttle *= 0.75;
    const effectiveRate = baseRate * throttle;
    const hashNeeded = effectiveRate * dt;
    const nextResources = { ...prev.resources };
    const availableHash = nextResources.hash || 0;
    const usedHash = Math.min(availableHash, hashNeeded);
    const producedCoin = usedHash;
    nextResources.hash = availableHash - usedHash;
    nextResources.coin = (nextResources.coin || 0) + producedCoin;
    tickCoin = producedCoin;
    tickHashUse = usedHash;
    const nextModules = {
      ...prev.modules,
      cpu: { ...cpuState, heat, throttle, lastRate: effectiveRate },
    };
    lastSnapshot = {
      ratePerSec: tickCoin / dt,
      hashUsePerSec: tickHashUse / dt,
      status: buildStatus(heat, availableHash),
      heat,
      throttle,
    };
    return { ...prev, resources: nextResources, modules: nextModules };
  });
}

export function render() {
  const state = store.getState();
  const cpuState = state.modules?.[id] || {};
  ui.update({
    level: cpuState.level || 1,
    cores: cpuState.cores || 1,
    heat: cpuState.heat || 0,
    throttle: cpuState.throttle || coolingEffect,
    unlocked: cpuState.unlocked !== false,
    ratePerSec: lastSnapshot.ratePerSec,
    hashUsePerSec: lastSnapshot.hashUsePerSec,
    status: lastSnapshot.status,
    upgradeCost: getUpgradeCost(cpuState.level || 1),
    canUpgrade: (state.resources.coin || 0) >= getUpgradeCost(cpuState.level || 1),
    coreCost: getCoreCost(cpuState.cores || 1),
    canAddCore:
      (state.resources.coin || 0) >= getCoreCost(cpuState.cores || 1) && (cpuState.cores || 1) < MAX_CORES,
    maxCores: MAX_CORES,
    hashReserve: state.resources.hash || 0,
  });
}

function buildStatus(heat, hashReserve) {
  if (hashReserve <= 0.01) return "En attente de hash";
  if (heat > 100) return "Surchauffe";
  if (heat > 80) return "Chaud";
  if (heat > 60) return "Veille thermique";
  return "Actif";
}

function upgrade() {
  store.setState((prev) => {
    const cpuState = prev.modules?.cpu || {};
    const cost = getUpgradeCost(cpuState.level || 1);
    if ((prev.resources.coin || 0) < cost) return prev;
    const nextResources = { ...prev.resources, coin: (prev.resources.coin || 0) - cost };
    const nextModules = {
      ...prev.modules,
      cpu: { ...cpuState, level: (cpuState.level || 1) + 1, unlocked: true },
    };
    return { ...prev, resources: nextResources, modules: nextModules };
  });
}

function addCore() {
  store.setState((prev) => {
    const cpuState = prev.modules?.cpu || {};
    const cores = cpuState.cores || 1;
    if (cores >= MAX_CORES) return prev;
    const cost = getCoreCost(cores);
    if ((prev.resources.coin || 0) < cost) return prev;
    const nextResources = { ...prev.resources, coin: (prev.resources.coin || 0) - cost };
    const nextModules = {
      ...prev.modules,
      cpu: { ...cpuState, cores: cores + 1, unlocked: true },
    };
    return { ...prev, resources: nextResources, modules: nextModules };
  });
}

function getUpgradeCost(level) {
  return Math.round(COST_BASE * Math.pow(COST_GROWTH, Math.max(0, level - 1)));
}

function getCoreCost(cores) {
  return Math.round(CORE_COST * Math.pow(CORE_GROWTH, Math.max(0, cores - 1)));
}
