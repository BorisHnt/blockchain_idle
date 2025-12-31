import { formatNumber, formatRate } from "../../app/utils.js";

export function createGpuUI(root, handlers) {
  root.innerHTML = `
    <div class="module-card gpu-card">
      <div class="gpu-head">
        <div>
          <p class="eyebrow">Compute + Énergie → Hash</p>
          <h2>GPU Farm</h2>
          <p class="muted">Transforme le compute en hashrate. Sensible au refroidissement.</p>
        </div>
        <div class="gpu-level">
          <span>Niv.</span>
          <strong data-level>1</strong>
        </div>
      </div>

      <div class="gpu-stats">
        <div>
          <div class="label">Hashrate</div>
          <div class="value" data-rate>0/s</div>
        </div>
        <div>
          <div class="label">Compute</div>
          <div class="value" data-compute>0/s</div>
        </div>
        <div>
          <div class="label">Énergie</div>
          <div class="value" data-energy>0/s</div>
        </div>
      </div>

      <div class="gpu-status">
        <span data-status>Actif</span>
        <span class="muted">Throttle <span data-throttle>1.0x</span></span>
      </div>

      <div class="gpu-actions">
        <button data-upgrade>Améliorer</button>
        <div class="muted small" data-cost>Coût: 0 CXT</div>
      </div>
    </div>
  `;

  const refs = {
    level: root.querySelector("[data-level]"),
    rate: root.querySelector("[data-rate]"),
    compute: root.querySelector("[data-compute]"),
    energy: root.querySelector("[data-energy]"),
    status: root.querySelector("[data-status]"),
    throttle: root.querySelector("[data-throttle]"),
    upgradeBtn: root.querySelector("[data-upgrade]"),
    cost: root.querySelector("[data-cost]"),
  };

  refs.upgradeBtn?.addEventListener("click", () => handlers.onUpgrade?.());

  return {
    update(view) {
      refs.level.textContent = view.level;
      refs.rate.textContent = `${formatRate(view.ratePerSec || 0)}/s`;
      refs.compute.textContent = `${formatRate(view.computeUse || 0)}/s`;
      refs.energy.textContent = `${formatRate(view.energyUse || 0)}/s`;
      refs.status.textContent = view.status;
      refs.throttle.textContent = `${formatRate(view.throttle || 0)}x`;
      if (refs.cost) refs.cost.textContent = `Coût: ${formatNumber(view.upgradeCost || 0)} CXT`;
      if (refs.upgradeBtn) refs.upgradeBtn.disabled = !view.canUpgrade;
    },
  };
}
