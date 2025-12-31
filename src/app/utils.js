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
