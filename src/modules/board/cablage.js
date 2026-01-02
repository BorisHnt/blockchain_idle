const isEnergyConnection = (conn) => conn.kind === "energy";

export function createCablage({ getNodeMeta, hasInputAnchor, hasOutputAnchor, hasEnergyInput, isUnlocked, flashHint }) {
  const tryCreate = (state, fromId, toId, targetType = "data") => {
    if (!fromId || !toId || fromId === toId) return state;
    const fromMeta = getNodeMeta(fromId);
    const toMeta = getNodeMeta(toId);
    if (!fromMeta || !toMeta) return state;
    const isEnergy = targetType === "energy";
    if (!hasOutputAnchor(fromMeta)) {
      flashHint("Connexion impossible");
      return state;
    }
    if (!isUnlocked(fromId) || !isUnlocked(toId)) {
      flashHint("Débloque d'abord");
      return state;
    }
    if (isEnergy) {
      if (!hasEnergyInput(toMeta)) {
        flashHint("Pas d'entrée énergie");
        return state;
      }
      if (fromMeta.output !== "energy") {
        flashHint("Sortie non énergie");
        return state;
      }
    } else if (targetType === "gpuopt") {
      if (toMeta.optInput !== "gpuopt") {
        flashHint("Pas d'entrée GPU Opt");
        return state;
      }
      if (fromMeta.output !== "gpuopt") {
        flashHint("Sortie non GPU Opt");
        return state;
      }
    } else {
      if (!hasInputAnchor(toMeta)) {
        flashHint("Ce module n'a pas d'entrée");
        return state;
      }
      if (fromMeta.output !== toMeta.input) {
        flashHint("Ressources incompatibles");
        return state;
      }
    }
    const exists = state.connections.some((c) => c.from === fromId && c.to === toId && c.kind === targetType);
    if (exists) {
      flashHint("Déjà connecté");
      return state;
    }
    state.connections = [...state.connections, { from: fromId, to: toId, kind: targetType }];
    return state;
  };

  const remove = (state, conn) => {
    state.connections = state.connections.filter(
      (c) => !(c.from === conn.from && c.to === conn.to && c.kind === conn.kind)
    );
    return state;
  };

  const listByNodeAndRole = (connections, nodeId, role) => {
    return connections.filter((c) => {
      if (role === "output") return c.from === nodeId;
      if (role === "input") return c.to === nodeId && !isEnergyConnection(c);
      if (role === "input-energy") return c.to === nodeId && isEnergyConnection(c);
      return false;
    });
  };

  return { tryCreate, remove, listByNodeAndRole };
}
