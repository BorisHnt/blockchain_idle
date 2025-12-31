import { formatNumber } from "../../app/utils.js";

export function createAlgorithmsUI(root, handlers) {
  root.innerHTML = `
    <div class="module-card algo-card">
      <div class="algo-head">
        <div>
          <p class="eyebrow">Optimisation</p>
          <h2>Algorithmes</h2>
          <p class="muted">Augmente l'efficacité CPU/GPU.</p>
        </div>
        <div class="algo-level">
          <span>Niv.</span>
          <strong data-level>0</strong>
        </div>
      </div>

      <div class="algo-body">
        <div class="label">Multiplicateur</div>
        <div class="value" data-mult>1.00x</div>
      </div>

      <div class="algo-actions">
        <button data-upgrade>Optimiser</button>
        <div class="muted small" data-cost>Coût: 0 CXT</div>
      </div>
    </div>
  `;

  const refs = {
    level: root.querySelector("[data-level]"),
    multiplier: root.querySelector("[data-mult]"),
    upgradeBtn: root.querySelector("[data-upgrade]"),
    cost: root.querySelector("[data-cost]"),
  };

  refs.upgradeBtn?.addEventListener("click", () => handlers.onUpgrade?.());

  return {
    update(view) {
      refs.level.textContent = view.level;
      refs.multiplier.textContent = `${view.multiplier?.toFixed(2)}x`;
      if (refs.cost) refs.cost.textContent = `Coût: ${formatNumber(view.cost || 0)} CXT`;
      if (refs.upgradeBtn) refs.upgradeBtn.disabled = !view.canUpgrade;
    },
  };
}
