import { formatNumber, formatRate } from "../../app/utils.js";

export function createCpuUI(root, handlers) {
  root.innerHTML = `
    <div class="module-card cpu-card">
      <div class="cpu-head">
        <div>
          <p class="eyebrow">Compute → Hash → Coin</p>
          <h2>CPU Miner</h2>
          <p class="muted">Mine les crédits en consommant du hashrate, sensible au refroidissement.</p>
        </div>
        <div class="cpu-level">
          <span>Niv.</span>
          <strong data-level>1</strong>
        </div>
      </div>

      <div class="cpu-stats">
        <div class="stat-block">
          <div class="label">Débit</div>
          <div class="value" data-rate>0/s</div>
          <div class="muted">Conso hash <span data-hash-use>0/s</span></div>
        </div>
        <div class="stat-block">
          <div class="label">Cores</div>
          <div class="value" data-cores>1</div>
          <div class="muted" data-core-limit> / 8</div>
        </div>
      </div>

      <div class="heat-bar" aria-label="Température CPU">
        <div class="heat-fill" data-heat></div>
      </div>
      <div class="heat-status">
        <span data-status>Actif</span>
        <span class="muted">Throttle <span data-throttle>1.0x</span></span>
      </div>

      <div class="cpu-actions">
        <button data-upgrade>Améliorer</button>
        <button data-core class="ghost">Ajouter un core</button>
      </div>
      <div class="muted small" data-costs>Coût: 0 CXT · Core: 0 CXT</div>
    </div>
  `;

  const refs = {
    level: root.querySelector("[data-level]"),
    rate: root.querySelector("[data-rate]"),
    hashUse: root.querySelector("[data-hash-use]"),
    cores: root.querySelector("[data-cores]"),
    coreLimit: root.querySelector("[data-core-limit]"),
    status: root.querySelector("[data-status]"),
    throttle: root.querySelector("[data-throttle]"),
    heat: root.querySelector("[data-heat]"),
    upgradeBtn: root.querySelector("[data-upgrade]"),
    coreBtn: root.querySelector("[data-core]"),
    costs: root.querySelector("[data-costs]"),
  };

  refs.upgradeBtn?.addEventListener("click", () => handlers.onUpgrade?.());
  refs.coreBtn?.addEventListener("click", () => handlers.onAddCore?.());

  return {
    update(view) {
      if (!view) return;
      refs.level.textContent = view.level;
      refs.rate.textContent = `${formatRate(view.ratePerSec || 0)}/s`;
      refs.hashUse.textContent = `${formatRate(view.hashUsePerSec || 0)}/s`;
      refs.cores.textContent = view.cores;
      refs.coreLimit.textContent = ` / ${view.maxCores}`;
      refs.status.textContent = view.status;
      refs.throttle.textContent = `${formatRate(view.throttle || 0)}x`;
      if (refs.costs) {
        refs.costs.textContent = `Coût: ${formatNumber(view.upgradeCost || 0)} CXT · Core: ${formatNumber(
          view.coreCost || 0
        )} CXT`;
      }
      if (refs.upgradeBtn) {
        refs.upgradeBtn.disabled = !view.canUpgrade;
        refs.upgradeBtn.textContent = view.unlocked ? "Améliorer" : "Débloquer";
      }
      if (refs.coreBtn) {
        refs.coreBtn.disabled = !view.canAddCore;
        refs.coreBtn.textContent = view.cores >= view.maxCores ? "Cores max" : "Ajouter un core";
      }
      const heat = Math.min(100, view.heat || 0);
      refs.heat.style.width = `${heat}%`;
      refs.heat.dataset.level = heat.toFixed(0);
      refs.heat.style.opacity = 0.35 + (heat / 100) * 0.65;
    },
  };
}
