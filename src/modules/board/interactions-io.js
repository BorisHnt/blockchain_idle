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
    inputDot.addEventListener("click", (e) => {
      e.stopPropagation();
      handlers.onShowMenu?.(e, { nodeId: meta.id, kind: meta.input, role: "input" });
    });
    inputDot.addEventListener("contextmenu", (e) =>
      handlers.onShowMenu?.(e, { nodeId: meta.id, kind: meta.input, role: "input" })
    );
  }
  if (energyDot) {
    energyDot.addEventListener("pointerenter", () => energyDot.classList.add("hover"));
    energyDot.addEventListener("pointerleave", () => energyDot.classList.remove("hover"));
    energyDot.addEventListener("click", (e) => {
      e.stopPropagation();
      handlers.onShowMenu?.(e, { nodeId: meta.id, kind: "energy", role: "input-energy" });
    });
    energyDot.addEventListener("contextmenu", (e) =>
      handlers.onShowMenu?.(e, { nodeId: meta.id, kind: "energy", role: "input-energy" })
    );
  }

  return { outputDot, inputDot, energyDot };
}

export function createIoContextMenu({ playfield, cablage, getNodeMeta, getConnections, onDisconnect }) {
  let contextMenuEl = null;
  let closer = null;

  const hide = () => {
    if (contextMenuEl?.parentNode) {
      contextMenuEl.parentNode.removeChild(contextMenuEl);
    }
    contextMenuEl = null;
    if (closer) {
      document.removeEventListener("pointerdown", closer, { capture: true });
      document.removeEventListener("wheel", closer, { passive: true });
    }
    closer = null;
  };

  const show = (e, options) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    hide();
    if (!playfield) return;
    const { nodeId, role } = options || {};
    if (!nodeId) return;
    const connections = getConnections?.() || [];
    const relevant = cablage.listByNodeAndRole(connections, nodeId, role);

    const menu = document.createElement("div");
    menu.className = "io-context-menu";
    menu.dataset.nodeId = nodeId;
    menu.dataset.role = role || "";

    if (relevant.length === 0) {
      const empty = document.createElement("div");
      empty.className = "io-context-item muted";
      empty.textContent = "Aucune connexion";
      menu.appendChild(empty);
    } else {
      relevant.forEach((conn) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "io-context-item";
        const otherId = role === "output" ? conn.to : conn.from;
        const otherMeta = getNodeMeta(otherId);
        item.textContent = `Déconnecter ${otherMeta ? otherMeta.name : otherId}`;
        item.addEventListener("click", (evt) => {
          evt.stopPropagation();
          onDisconnect?.(conn);
          hide();
        });
        menu.appendChild(item);
      });
    }

    playfield.appendChild(menu);
    const rect = playfield.getBoundingClientRect();
    const x = (e?.clientX ?? rect.left) - rect.left;
    const y = (e?.clientY ?? rect.top) - rect.top;
    menu.style.left = `${Math.max(8, x + 10)}px`;
    menu.style.top = `${Math.max(8, y + 10)}px`;
    contextMenuEl = menu;

    const handler = (ev) => {
      if (contextMenuEl && contextMenuEl.contains(ev.target)) return;
      hide();
    };
    closer = handler;
    setTimeout(() => {
      document.addEventListener("pointerdown", handler, { capture: true });
      document.addEventListener("wheel", handler, { passive: true });
    }, 0);
  };

  return { show, hide };
}
