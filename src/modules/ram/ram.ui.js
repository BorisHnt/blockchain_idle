import { formatNumber, formatRate } from "../../app/utils.js";

export function createRamUI(root, handlers) {
  root.innerHTML = `
    <div class="module-card ram-card">
      <div class="ram-head">
        <div>
          <p class="eyebrow">Cache</p>
          <h2>RAM Cache</h2>
          <p class="muted">Précharge les blocs pour générer du compute régulier.</p>
        </div>
        <div class="ram-level">
          <span>Niv.</span>
          <strong data-level>0</strong>
        </div>
      </div>

      <div class="ram-body">
        <div class="label">Production</div>
        <div class="value" data-rate>0/s</div>
        <div class="muted" data-status>Verrouillé</div>
      </div>

      <div class="ram-actions">
        <button data-upgrade>Débloquer/Upgrade</button>
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
      if (refs.cost) refs.cost.textContent = `Coût: ${formatNumber(view.upgradeCost || 0)} CXT`;
      if (refs.upgradeBtn) refs.upgradeBtn.disabled = !view.canUpgrade;
    },
  };
}
