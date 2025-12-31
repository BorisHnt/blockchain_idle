export function createWires({ playfield, wiresSvg, getNodeMeta, isUnlocked, getLevel }) {
  let preview = null;
  let lastConnections = [];
  let lastBindings = {};

  const isEnergyConnection = (conn) => conn.kind === "energy";

  const render = (connections, bindings) => {
    lastConnections = connections;
    lastBindings = bindings;
    const rect = playfield.getBoundingClientRect();
    wiresSvg.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
    wiresSvg.setAttribute("width", rect.width);
    wiresSvg.setAttribute("height", rect.height);
    wiresSvg.innerHTML = "";

    connections.forEach((conn) => {
      const from = bindings[conn.from];
      const to = bindings[conn.to];
      if (!from || !to) return;
      const fromMeta = getNodeMeta(conn.from);
      const toMeta = getNodeMeta(conn.to);
      const isEnergy = isEnergyConnection(conn);
      if (!fromMeta?.output) return;
      if (isEnergy ? !toMeta?.energyUse : !toMeta?.input) return;

      const start = getDotCenter(from.outputDot);
      const targetEnergyDot = to.energyDot || to.inputDot;
      const end = isEnergy ? getDotCenter(targetEnergyDot) : getDotCenter(to.inputDot);
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      const midX = (start.x + end.x) / 2;
      const d = `M ${start.x} ${start.y} C ${midX} ${start.y}, ${midX} ${end.y}, ${end.x} ${end.y}`;
      path.setAttribute("d", d);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke-width", "3");
      path.setAttribute("stroke-linecap", "round");
      const active = isUnlocked(conn.from) && getLevel(conn.from) > 0;
      const color = isEnergy ? "#ffd166" : "#4dd4ff";
      path.setAttribute("stroke", active ? color : "rgba(255,255,255,0.15)");
      path.setAttribute("opacity", active ? "0.9" : "0.4");
      wiresSvg.appendChild(path);
    });

    if (preview) {
      const { fromId, toPoint, kind } = preview;
      const from = bindings[fromId];
      if (from) {
        const start = getDotCenter(from.outputDot);
        const midX = (start.x + toPoint.x) / 2;
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        const d = `M ${start.x} ${start.y} C ${midX} ${start.y}, ${midX} ${toPoint.y}, ${toPoint.x} ${toPoint.y}`;
        path.setAttribute("d", d);
        path.setAttribute("fill", "none");
        path.setAttribute("stroke-width", "2");
        path.setAttribute("stroke-dasharray", "6 4");
        path.setAttribute("stroke", kind === "energy" ? "rgba(255,209,102,0.85)" : "rgba(77,212,255,0.8)");
        path.setAttribute("opacity", "0.8");
        wiresSvg.appendChild(path);
      }
    }
  };

  const setPreview = (nextPreview) => {
    preview = nextPreview;
    render(lastConnections, lastBindings);
  };

  const clearPreview = () => {
    preview = null;
    render(lastConnections, lastBindings);
  };

  const getDotCenter = (el) => {
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    const parent = playfield.getBoundingClientRect();
    return { x: rect.left - parent.left + rect.width / 2, y: rect.top - parent.top + rect.height / 2 };
  };

  return { render, setPreview, clearPreview };
}
