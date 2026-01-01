// Centralise les formules d'équilibrage du board.
// Chaque fonction contient des exemples en commentaire pour faciliter les réglages.

export const BASE_UPGRADE_GROWTH = 1.22; // croissance générique des upgrades (hors Energy)
export const ENERGY_LEVEL_GROWTH = 1.25; // croissance de la prod de l'Energy Source par niveau

// Power Cells : 4 blocs de 8 cellules, avec puissance et coût propres.
// costFn prend un index de cellule (1-based) et retourne un coût CXT.
export const POWER_CELLS_PER_BLOCK = 8;
export const POWER_CELL_BLOCKS = [
  { power: 50, costFn: (i) => 100 * i - 5 }, // ex: i=1 => 45, i=2 => 95, i=3 => 145
  { power: 100, costFn: (i) => 200 * (2 * i) - 10 }, // ex: i=1 => 190, i=2 => 390
  { power: 200, costFn: (i) => 400 * (4 * i) - 20 }, // ex: i=1 => 780, i=2 => 1580
  { power: 400, costFn: (i) => 800 * (8 * i) - 40 }, // ex: i=1 => 3160, i=2 => 6360
];

// Coût de base du multiplicateur de puissance des Power Cells.
// Exemple : base = 400 * (8 * 9) = 28800, niveau 0->1 coûte 28800, niveau 1->2 coûte 57600, etc.
export const POWER_MULT_BASE_COST = 400 * (8 * 9);

// ---- Upgrades génériques et Energy Source ----

// Coût d'upgrade d'un nœud générique (hors Energy Source).
// Exemple : baseCost=120, level=0 => 120 ; level=1 => 146 ; level=2 => 178
export function getGenericUpgradeCost(baseCost, currentLevel) {
  return Math.round(baseCost * Math.pow(BASE_UPGRADE_GROWTH, currentLevel));
}

// Coût d'upgrade de l'Energy Source vers le niveau suivant.
// Formule : 100 * exp(2 * (nextLevel-1)^0.5)
// Exemples : level=0 => 100 ; level=1 => 739 ; level=2 => 1694 ; level=3 => 3190 ; level=4 => 5460
export function getEnergyUpgradeCost(currentLevel) {
  const nextLevel = currentLevel + 1;
  return Math.round(100 * Math.exp(2 * Math.pow(Math.max(1, nextLevel) - 1, 0.5)));
}

// Multiplicateur de prod de l'Energy Source en fonction du niveau (sans power cells).
// Exemple : level=1 => x1 ; level=2 => x1.25 ; level=3 => x1.56
export function getEnergyLevelScale(level) {
  return Math.pow(ENERGY_LEVEL_GROWTH, Math.max(0, level - 1));
}

// ---- Power Cells ----

// Coût de la prochaine cellule pour un bloc donné (index 0-3), cellule 1-based.
export function getPowerCellCost(blockIndex, cellIndex) {
  const def = POWER_CELL_BLOCKS[blockIndex];
  if (!def) return Infinity;
  return Math.max(0, Math.round(def.costFn(cellIndex)));
}

// Coût de déblocage du bloc suivant : coût de la cellule 9 du bloc précédent.
// Exemple : débloquer bloc 2 => costFn(9) du bloc 1.
export function getUnlockNextBlockCost(prevBlockIndex) {
  const def = POWER_CELL_BLOCKS[prevBlockIndex];
  if (!def) return null;
  return Math.max(0, Math.round(def.costFn(POWER_CELLS_PER_BLOCK + 1)));
}

// ---- Multiplicateur de puissance ----

// Coût du multiplicateur pour passer du niveau courant au niveau suivant.
// Exemple : level=0 => 28800 ; level=1 => 57600 ; level=2 => 115200 ; level=3 => 230400
export function getPowerMultiplierCost(currentLevel) {
  return Math.round(POWER_MULT_BASE_COST * Math.pow(2, currentLevel));
}
