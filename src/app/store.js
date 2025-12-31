const clone = (value) => {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
};

const mergeState = (prev, patch) => {
  if (!patch || typeof patch !== "object") return prev;
  return { ...prev, ...patch };
};

export function createStore(initialState = {}) {
  let state = clone(initialState);
  const subscribers = new Set();

  const getState = () => state;

  const setState = (patchOrFn) => {
    const next = typeof patchOrFn === "function" ? patchOrFn(state) : mergeState(state, patchOrFn);
    if (!next || next === state) return;
    state = next;
    subscribers.forEach((fn) => fn(state));
  };

  const subscribe = (fn) => {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  };

  return { getState, setState, subscribe };
}
