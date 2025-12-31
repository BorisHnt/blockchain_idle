export function createBus() {
  const handlers = new Map();

  const on = (eventName, handler) => {
    if (!handlers.has(eventName)) {
      handlers.set(eventName, new Set());
    }
    const bucket = handlers.get(eventName);
    bucket.add(handler);
    return () => bucket.delete(handler);
  };

  const emit = (eventName, payload) => {
    const bucket = handlers.get(eventName);
    if (!bucket) return;
    bucket.forEach((fn) => fn(payload));
  };

  return { on, emit };
}
