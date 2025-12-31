export function bindIoDots(card, meta, handlers) {
  const outputDot = card.querySelector(".io-dot.output");
  const inputDot = card.querySelector(".io-dot.input");
  const energyDot = card.querySelector(".io-dot.energy:not(.output)");

  if (outputDot) {
    outputDot.addEventListener("pointerdown", (e) => handlers.onStartLink?.(e, meta.id, outputDot.dataset.outType || meta.output));
    outputDot.addEventListener("contextmenu", (e) =>
      handlers.onShowMenu?.(e, { nodeId: meta.id, kind: meta.output, role: "output" })
    );
  }
  if (inputDot) {
    inputDot.addEventListener("pointerenter", () => inputDot.classList.add("hover"));
    inputDot.addEventListener("pointerleave", () => inputDot.classList.remove("hover"));
    inputDot.addEventListener("click", (e) => handlers.onShowMenu?.(e, { nodeId: meta.id, kind: meta.input, role: "input" }));
    inputDot.addEventListener("contextmenu", (e) =>
      handlers.onShowMenu?.(e, { nodeId: meta.id, kind: meta.input, role: "input" })
    );
  }
  if (energyDot) {
    energyDot.addEventListener("pointerenter", () => energyDot.classList.add("hover"));
    energyDot.addEventListener("pointerleave", () => energyDot.classList.remove("hover"));
    energyDot.addEventListener("click", (e) => handlers.onShowMenu?.(e, { nodeId: meta.id, kind: "energy", role: "input-energy" }));
    energyDot.addEventListener("contextmenu", (e) =>
      handlers.onShowMenu?.(e, { nodeId: meta.id, kind: "energy", role: "input-energy" })
    );
  }

  return { outputDot, inputDot, energyDot };
}
