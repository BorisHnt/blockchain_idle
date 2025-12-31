import { formatNumber } from "../../app/utils.js";

export function createCoolingUI(root, handlers) {
  root.innerHTML = `
    <div class="module-card cooling-card">
      <div class="cooling-head">
        <div>
          <p class="eyebrow">Thermique</p>
          <h2>Refroidissement</h2>
          <p class="muted">Stabilise le CPU/GPU et réduit le throttling.</p>
        </div>
        <div class="cooling-level">
          <span>Niv.</span>
          <strong data-level>1</strong>
        </div>
      </div>

      <div class="cooling-body">
        <div class="label">Efficacité</div>
        <div class="value" data-eff>1.00x</div>
        <div class="risk-bar">
          <div class="risk-fill" data-risk></div>
        </div>
        <div class="muted small">Risque de surchauffe</div>
      </div>

      <div class="cooling-actions">
        <button data-upgrade>Améliorer</button>
        <div class="muted small" data-cost>Coût: 0 CXT</div>
      </div>
    </div>
  `;

  const refs = {
    level: root.querySelector("[data-level]"),
    efficiency: root.querySelector("[data-eff]"),
    risk: root.querySelector("[data-risk]"),
    upgradeBtn: root.querySelector("[data-upgrade]"),
    cost: root.querySelector("[data-cost]"),
  };

  refs.upgradeBtn?.addEventListener("click", () => handlers.onUpgrade?.());

  return {
    update(view) {
      refs.level.textContent = view.level;
      refs.efficiency.textContent = `${view.efficiency?.toFixed(2)}x`;
      const riskVal = Math.min(1, Math.max(0, view.overheatRisk || 0));
      refs.risk.style.width = `${(riskVal || 0) * 100}%`;
      refs.risk.style.opacity = 0.25 + riskVal * 0.75;
      if (refs.cost) refs.cost.textContent = `Coût: ${formatNumber(view.cost || 0)} CXT`;
      if (refs.upgradeBtn) refs.upgradeBtn.disabled = !view.canUpgrade;
    },
  };
}
