import { formatNumber, formatRate } from "../../app/utils.js";

export function createRndUI(root, handlers) {
  root.innerHTML = `
    <div class="module-card rnd-card">
      <div class="rnd-head">
        <div>
          <p class="eyebrow">Recherche</p>
          <h2>R&D Lab</h2>
          <p class="muted">Convertit des crédits + énergie en compétences.</p>
        </div>
        <div class="rnd-level">
          <span>Niv.</span>
          <strong data-level>0</strong>
        </div>
      </div>

      <div class="rnd-body">
        <div class="label">Production XP</div>
        <div class="value" data-rate>0/s</div>
        <div class="muted" data-status>Verrouillé</div>
      </div>

      <div class="rnd-actions">
        <button data-upgrade>Financer</button>
        <div class="muted small" data-cost>Coût: 0 CXT</div>
      </div>
    </div>
  `;

  const refs = {
    level: root.querySelector("[data-level]"),
    rate: root.querySelector("[data-rate]"),
    status: root.querySelector("[data-status]"),
    upgradeBtn: root.querySelector("[data-upgrade]"),
    cost: root.querySelector("[data-cost]"),
  };

  refs.upgradeBtn?.addEventListener("click", () => handlers.onUpgrade?.());

  return {
    update(view) {
      refs.level.textContent = view.level;
      refs.rate.textContent = `${formatRate(view.ratePerSec || 0)}/s`;
      refs.status.textContent = view.status;
      if (refs.cost) refs.cost.textContent = `Coût: ${formatNumber(view.cost || 0)} CXT`;
      if (refs.upgradeBtn) refs.upgradeBtn.disabled = !view.canUpgrade;
    },
  };
}
