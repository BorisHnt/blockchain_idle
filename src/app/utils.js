export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const formatNumber = (value) => {
  if (!Number.isFinite(value)) return "0";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (abs >= 1_000) return value.toFixed(0);
  if (abs >= 1) return value.toFixed(1);
  return value.toFixed(2);
};

export const formatRate = (value) => {
  if (Math.abs(value) < 0.01) return "0";
  if (Math.abs(value) < 1) return value.toFixed(2);
  return value.toFixed(1);
};

export const formatSeconds = (sec) => {
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  if (hours > 0) return `${hours}h${minutes.toString().padStart(2, "0")}`;
  return `${minutes}min`;
};

export const shallowClone = (value) => ({ ...value });

export const formatBandwidth = (value) => {
  if (!Number.isFinite(value)) return "0 Mo";
  const abs = Math.abs(value);
  if (abs >= 1_048_576) return `${(value / 1_048_576).toFixed(2)} To`;
  if (abs >= 1024) return `${(value / 1024).toFixed(2)} Go`;
  if (abs >= 1) return `${value.toFixed(1)} Mo`;
  return `${value.toFixed(2)} Mo`;
};

export const formatBandwidthRate = (value) => {
  if (!Number.isFinite(value)) return "0 Mo/s";
  const abs = Math.abs(value);
  if (abs >= 1_048_576) return `${(value / 1_048_576).toFixed(2)} To/s`;
  if (abs >= 1024) return `${(value / 1024).toFixed(2)} Go/s`;
  if (abs >= 1) return `${value.toFixed(1)} Mo/s`;
  return `${value.toFixed(2)} Mo/s`;
};
