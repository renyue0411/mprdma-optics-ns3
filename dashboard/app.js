const COLORS = [
  '#3f86b8', '#b86b3f', '#5a9b74', '#8666b8', '#b84f6b', '#6e9bb8',
  '#c1a243', '#4a9f9a', '#a05f9f', '#7c8f3a', '#2f658d', '#9d6b41'
];

let allExperiments = [];
let selectedExperiment = null;
let hiddenThroughputSeries = new Set();

function fmtNs(ns) {
  if (ns === null || ns === undefined || Number.isNaN(ns)) return '-';
  if (Math.abs(ns) >= 1e9) return `${(ns / 1e9).toFixed(3)} s`;
  if (Math.abs(ns) >= 1e6) return `${(ns / 1e6).toFixed(3)} ms`;
  if (Math.abs(ns) >= 1e3) return `${(ns / 1e3).toFixed(3)} µs`;
  return `${ns} ns`;
}

function fmtBytes(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '-';
  return `${Math.round(v).toLocaleString()} B`;
}

function fmtGbps(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '-';
  return `${v.toFixed(3)} Gbps`;
}

function fmtOptionalNs(ns) {
  if (ns === null || ns === undefined || Number.isNaN(ns)) return '-';
  return fmtNs(ns);
}

function fmtOptionalGbps(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '-';
  return fmtGbps(v);
}

function fmtStatus(v) {
  if (v === 'completed') {
    return '<span class="status-pill status-completed">completed</span>';
  }
  if (v === 'missing') {
    return '<span class="status-pill status-missing">missing</span>';
  }
  return escapeHtml(v || '-');
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function loadData() {
  try {
    const res = await fetch('/api/experiments', {cache: 'no-store'});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    allExperiments = data.experiments || [];
  } catch (err) {
    console.error(err);
    allExperiments = [];
  }
  renderExperimentList();
  if (allExperiments.length > 0) {
    selectExperiment(allExperiments[allExperiments.length - 1].id);
  }
}

function renderExperimentList() {
  const root = document.getElementById('experimentList');
  const q = document.getElementById('experimentSearch').value.toLowerCase();
  const items = allExperiments.filter(exp => `${exp.title} ${exp.id}`.toLowerCase().includes(q));

  root.innerHTML = items.map(exp => `
    <div class="exp-item ${selectedExperiment && selectedExperiment.id === exp.id ? 'active' : ''}" data-id="${escapeHtml(exp.id)}">
      <h4>${escapeHtml(exp.title || exp.id)}</h4>
    </div>
  `).join('') || '<p class="muted">No experiments found. Run scripts/run_dashboard_experiment.py first.</p>';

  root.querySelectorAll('.exp-item').forEach(el => {
    el.addEventListener('click', () => selectExperiment(el.dataset.id));
  });
}

function selectExperiment(id) {
  const nextExperiment = allExperiments.find(e => e.id === id) || allExperiments[0] || null;

  if (!selectedExperiment || !nextExperiment || selectedExperiment.id !== nextExperiment.id) {
    hiddenThroughputSeries.clear();
  }

  selectedExperiment = nextExperiment;
  renderExperimentList();
  renderExperiment();
}

function renderExperiment() {
  const exp = selectedExperiment;
  if (!exp) return;

  document.getElementById('experimentTitle').textContent = exp.title || exp.id;
  document.getElementById('experimentMeta').textContent = '';

  renderBadges(exp);
  renderSliceTopology(exp);
  renderThroughput(exp);
  renderFlowResultTable(exp);
  renderOcsStats(exp);
  renderInjectionTable(exp);
  renderInjectionControlSummary(exp);
  renderUserspacePostTable(exp);
  renderRnicRetxTable(exp);

  requestAnimationFrame(syncInjectionWindowHeight);
}

function syncInjectionWindowHeight() {
  const left = document.querySelector('.control-plane-left');
  const right = document.querySelector('.injection-window-card');

  if (!left || !right) return;

  const leftHeight = left.offsetHeight;

  if (leftHeight > 0) {
    right.style.height = `${leftHeight}px`;
  }
}

function renderBadges(exp) {
  const s = exp.summary || {};

  document.getElementById('summaryBadges').innerHTML = `
    <span class="badge">Node: ${s.nodeCount ?? 0}</span>
    <span class="badge">OCS: ${s.ocsCount ?? 0}</span>
    <span class="badge">EPS: ${s.epsCount ?? 0}</span>
    <span class="badge">Flow: ${s.flowCount ?? 0}</span>
    <span class="badge">OCS Mode: ${escapeHtml(s.ocsMode || '-')}</span>
    <span class="badge">CC Method: ${escapeHtml(s.ccName || '-')}</span>
    <span class="badge">Injection Control: ${escapeHtml(s.injectionModeName || s.rnicGateMode || '-')}</span>
  `;
}

function buildAdjacency(topology) {
  const adj = new Map();

  (topology.nodes || []).forEach(n => adj.set(n.id, []));

  (topology.links || []).forEach(l => {
    if (!adj.has(l.src)) adj.set(l.src, []);
    if (!adj.has(l.dst)) adj.set(l.dst, []);
    adj.get(l.src).push(l.dst);
    adj.get(l.dst).push(l.src);
  });

  return adj;
}

function chooseHierarchyRoots(topology, adj) {
  const ocs = (topology.nodes || [])
    .filter(n => n.type === 'ocs')
    .map(n => n.id);

  if (!ocs.length) {
    return (topology.nodes || []).map(n => n.id).slice(0, 1);
  }

  const ocsSet = new Set(ocs);

  const score = id => {
    const neighbors = adj.get(id) || [];
    const ocsDegree = neighbors.filter(v => ocsSet.has(v)).length;
    return ocsDegree * 1000 + neighbors.length;
  };

  let best = ocs[0];

  ocs.forEach(id => {
    if (score(id) > score(best) || (score(id) === score(best) && id > best)) {
      best = id;
    }
  });

  return [best];
}

function buildHierarchy(topology) {
  const adj = buildAdjacency(topology);
  const nodesById = new Map((topology.nodes || []).map(n => [n.id, n]));
  const roots = chooseHierarchyRoots(topology, adj);

  const level = new Map();
  const parent = new Map();
  const queue = [];

  roots.forEach(r => {
    level.set(r, 0);
    queue.push(r);
  });

  while (queue.length) {
    const u = queue.shift();
    const next = (adj.get(u) || []).slice().sort((a, b) => a - b);

    next.forEach(v => {
      if (!level.has(v)) {
        level.set(v, level.get(u) + 1);
        parent.set(v, u);
        queue.push(v);
      }
    });
  }

  (topology.nodes || []).forEach(n => {
    if (!level.has(n.id)) {
      level.set(n.id, 0);
      roots.push(n.id);
    }
  });

  const children = new Map();

  (topology.nodes || []).forEach(n => children.set(n.id, []));

  parent.forEach((p, child) => {
    if (children.has(p)) {
      children.get(p).push(child);
    }
  });

  children.forEach(list => {
    list.sort((a, b) => {
      const ta = nodesById.get(a)?.type || '';
      const tb = nodesById.get(b)?.type || '';
      const pa = ta === 'ocs' ? 0 : ta === 'eps' ? 1 : 2;
      const pb = tb === 'ocs' ? 0 : tb === 'eps' ? 1 : 2;
      return pa - pb || a - b;
    });
  });

  return {
    roots: Array.from(new Set(roots)),
    level,
    parent,
    children,
    nodesById
  };
}


function hasLogicalEndpointView(topology) {
  return (topology.logicalNodes || []).some(n => (n.endpoints || []).length > 0);
}

function typeOrderForFabric(t) {
  if (t === 'ocs') return 0;
  if (t === 'eps') return 1;
  return 2;
}

function addUndirectedLayoutEdge(adj, a, b) {
  if (a === b) return;
  if (!adj.has(a)) adj.set(a, new Set());
  if (!adj.has(b)) adj.set(b, new Set());
  adj.get(a).add(b);
  adj.get(b).add(a);
}

function shortestLayoutDistances(adj, starts, allowed) {
  const distance = new Map();
  const queue = [];

  starts.forEach(key => {
    if (!allowed.has(key) || distance.has(key)) return;
    distance.set(key, 0);
    queue.push(key);
  });

  while (queue.length) {
    const current = queue.shift();
    const nextDistance = distance.get(current) + 1;

    Array.from(adj.get(current) || [])
      .filter(key => allowed.has(key))
      .sort()
      .forEach(key => {
        if (distance.has(key)) return;
        distance.set(key, nextDistance);
        queue.push(key);
      });
  }

  return distance;
}

function connectedLayoutComponents(vertexKeys, adj) {
  const remaining = new Set(vertexKeys);
  const components = [];

  while (remaining.size) {
    const start = Array.from(remaining).sort()[0];
    const component = new Set([start]);
    const queue = [start];
    remaining.delete(start);

    while (queue.length) {
      const current = queue.shift();

      Array.from(adj.get(current) || [])
        .sort()
        .forEach(next => {
          if (!remaining.has(next)) return;
          remaining.delete(next);
          component.add(next);
          queue.push(next);
        });
    }

    components.push(component);
  }

  return components.sort((a, b) => {
    return Array.from(a).sort()[0].localeCompare(Array.from(b).sort()[0]);
  });
}

function chooseConnectivityRoots(component, vertices, adj, explicitTerminals) {
  const candidates = Array.from(component).filter(key => vertices.get(key)?.kind !== 'logical');
  const usableCandidates = candidates.length ? candidates : Array.from(component);
  const terminals = explicitTerminals.filter(key => component.has(key));

  if (terminals.length) {
    // Multi-source distance from all endpoint/logical-node leaves. Vertices
    // furthest from their nearest endpoint form the physical fabric core.
    const distanceFromEndpoints = shortestLayoutDistances(adj, terminals, component);
    const maxDistance = Math.max(
      0,
      ...usableCandidates.map(key => distanceFromEndpoints.get(key) ?? 0)
    );

    const roots = usableCandidates
      .filter(key => (distanceFromEndpoints.get(key) ?? 0) === maxDistance)
      .sort((a, b) => {
        const degreeDiff = (adj.get(b)?.size || 0) - (adj.get(a)?.size || 0);
        return degreeDiff || a.localeCompare(b);
      });

    // Keep all adjacent/equivalent core vertices at level 0. This avoids
    // inventing an arbitrary hierarchy inside a symmetric fabric core.
    return roots;
  }

  // No explicit endpoint is available. Select the graph centre using minimum
  // eccentricity, with degree as the deterministic tie-breaker.
  let bestEccentricity = Infinity;
  let roots = [];

  usableCandidates.forEach(candidate => {
    const distances = shortestLayoutDistances(adj, [candidate], component);
    const eccentricity = Math.max(0, ...Array.from(component).map(key => distances.get(key) ?? 0));

    if (eccentricity < bestEccentricity) {
      bestEccentricity = eccentricity;
      roots = [candidate];
      return;
    }

    if (eccentricity === bestEccentricity) {
      roots.push(candidate);
    }
  });

  const maxDegree = Math.max(0, ...roots.map(key => adj.get(key)?.size || 0));
  return roots
    .filter(key => (adj.get(key)?.size || 0) === maxDegree)
    .sort();
}

function layoutConnectivityGraph(vertices, adj, terminalKeys) {
  const components = connectedLayoutComponents(Array.from(vertices.keys()), adj);
  const placements = new Map();
  const componentGap = 110;
  const horizontalGap = 42;
  const minimumSlotWidth = 96;
  const levelGap = 112;
  const topPad = 58;
  const leftPad = 54;
  let globalCursor = leftPad;
  let maximumLevel = 0;

  function layoutOrderValue(key) {
    const vertex = vertices.get(key);

    if (vertex?.kind === 'logical') {
      const logicalId = Number(vertex.item?.logicalId);
      return Number.isFinite(logicalId) ? logicalId : Number.MAX_SAFE_INTEGER;
    }

    const nodeId = Number(vertex?.node?.id);
    return Number.isFinite(nodeId) ? nodeId : Number.MAX_SAFE_INTEGER;
  }

  function compareLayoutKeys(a, b) {
    const numericDiff = layoutOrderValue(a) - layoutOrderValue(b);
    if (numericDiff !== 0) return numericDiff;
    return a.localeCompare(b, undefined, {numeric: true});
  }

  components.forEach(component => {
    const roots = Array.from(new Set(
      chooseConnectivityRoots(component, vertices, adj, terminalKeys)
    ));
    const level = new Map();
    const queue = [];

    roots.forEach(root => {
      level.set(root, 0);
      queue.push(root);
    });

    while (queue.length) {
      const current = queue.shift();
      const neighbors = Array.from(adj.get(current) || [])
        .filter(key => component.has(key))
        .sort((a, b) => {
          const degreeDiff = (adj.get(b)?.size || 0) - (adj.get(a)?.size || 0);
          return degreeDiff || a.localeCompare(b);
        });

      neighbors.forEach(next => {
        if (level.has(next)) return;
        level.set(next, level.get(current) + 1);
        queue.push(next);
      });
    }

    // Keep every malformed/disconnected vertex visible without introducing a
    // device-type-based hierarchy.
    Array.from(component).sort().forEach(key => {
      if (!level.has(key)) {
        level.set(key, 0);
        roots.push(key);
      }
    });

    const componentMaxLevel = Math.max(
      0,
      ...Array.from(component).map(key => level.get(key) || 0)
    );
    maximumLevel = Math.max(maximumLevel, componentMaxLevel);

    const layers = Array.from({length: componentMaxLevel + 1}, () => []);
    Array.from(component).sort().forEach(key => {
      layers[level.get(key) || 0].push(key);
    });

    // Keep the connectivity-derived level, but order every level strictly by
    // its displayed numeric identifier from left to right. Device type does
    // not affect the order: O5 precedes O6, E1 precedes E2, and logical
    // Node 19 precedes Node 23 when they share the same level.
    layers.forEach(layerKeys => {
      layerKeys.sort(compareLayoutKeys);
    });

    // Calculate spacing independently for every level. A logical Node → NIC
    // → Plane group is wider than an OCS/EPS icon; using one component-wide
    // slot width made the endpoint layer unnecessarily sparse.
    const layerMetrics = layers.map(layerKeys => {
      const layerVertexWidth = Math.max(
        64,
        ...layerKeys.map(key => vertices.get(key)?.width || 64)
      );
      const logicalOnly = layerKeys.length > 0 && layerKeys.every(key => {
        return vertices.get(key)?.kind === 'logical';
      });
      const layerHorizontalGap = logicalOnly ? 16 : horizontalGap;
      const layerMinimumSlotWidth = logicalOnly ? 72 : minimumSlotWidth;
      const slotWidth = Math.max(
        layerMinimumSlotWidth,
        layerVertexWidth + layerHorizontalGap
      );
      const layerWidth = layerVertexWidth + Math.max(0, layerKeys.length - 1) * slotWidth;

      return {
        layerVertexWidth,
        slotWidth,
        layerWidth
      };
    });

    const componentWidth = Math.max(
      64,
      ...layerMetrics.map(metric => metric.layerWidth)
    );
    const componentCenter = globalCursor + componentWidth / 2;

    layers.forEach((layerKeys, currentLevel) => {
      if (!layerKeys.length) return;

      const slotWidth = layerMetrics[currentLevel].slotWidth;
      const layerSpan = (layerKeys.length - 1) * slotWidth;
      const layerStart = componentCenter - layerSpan / 2;

      layerKeys.forEach((key, index) => {
        placements.set(key, {
          x: layerStart + index * slotWidth,
          y: topPad + currentLevel * levelGap,
          level: currentLevel
        });
      });
    });

    globalCursor += componentWidth + componentGap;
  });

  return {
    placements,
    width: Math.max(460, globalCursor - componentGap + leftPad),
    height: topPad + maximumLevel * levelGap + 70
  };
}

function buildLogicalLayouts(topology) {
  const planeGap = 22;
  const nicGap = 8;
  const nicCardHeight = 24;
  const nodeCardHeight = 20;

  return (topology.logicalNodes || [])
    .slice()
    .sort((a, b) => Number(a.logicalId) - Number(b.logicalId))
    .map(ln => {
      const endpoints = (ln.endpoints || []).slice().sort((a, b) => {
        return Number(a.rnicGroupId) - Number(b.rnicGroupId) ||
          Number(a.planeId) - Number(b.planeId) ||
          Number(a.carrierNodeId) - Number(b.carrierNodeId);
      });
      const nicMap = new Map();

      endpoints.forEach(ep => {
        const nicId = Number(ep.rnicGroupId);
        if (!nicMap.has(nicId)) nicMap.set(nicId, []);
        nicMap.get(nicId).push(ep);
      });

      const nics = Array.from(nicMap.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([nicId, nicEndpoints]) => {
          const sortedEndpoints = nicEndpoints.slice().sort((a, b) => {
            return Number(a.planeId) - Number(b.planeId) ||
              Number(a.carrierNodeId) - Number(b.carrierNodeId);
          });

          return {
            nicId,
            endpoints: sortedEndpoints,
            width: Math.max(42, 18 + sortedEndpoints.length * planeGap)
          };
        });

      const totalNicWidth = nics.reduce((sum, nic) => sum + nic.width, 0) +
        Math.max(0, nics.length - 1) * nicGap;

      return {
        logicalId: ln.logicalId,
        label: ln.label || `Node ${ln.logicalId}`,
        endpoints,
        nics,
        width: Math.max(62, totalNicWidth + 12),
        nodeCardHeight,
        nicCardHeight,
        nicGap,
        planeGap
      };
    });
}

function layoutLogicalEndpointTopology(topology) {
  const nodes = topology.nodes || [];
  const links = topology.links || [];
  const nodeById = new Map(nodes.map(node => [Number(node.id), node]));
  const logicalLayouts = buildLogicalLayouts(topology);
  const logicalById = new Map(logicalLayouts.map(item => [String(item.logicalId), item]));
  const carrierToLogical = new Map();
  const vertices = new Map();
  const adj = new Map();
  const pos = new Map();

  logicalLayouts.forEach(item => {
    const key = `logical:${item.logicalId}`;
    vertices.set(key, {
      key,
      kind: 'logical',
      width: item.width,
      item
    });
    adj.set(key, new Set());

    item.endpoints.forEach(ep => {
      carrierToLogical.set(Number(ep.carrierNodeId), key);
    });
  });

  nodes
    .filter(node => node.type !== 'rnic' || !carrierToLogical.has(Number(node.id)))
    .forEach(node => {
      const key = `node:${node.id}`;
      vertices.set(key, {
        key,
        kind: 'fabric',
        width: node.type === 'eps' ? 72 : 68,
        node
      });
      adj.set(key, new Set());
    });

  const displayKeyForNode = nodeId => {
    const numericId = Number(nodeId);
    if (carrierToLogical.has(numericId)) return carrierToLogical.get(numericId);
    return `node:${numericId}`;
  };

  links.forEach(link => {
    const a = displayKeyForNode(link.src);
    const b = displayKeyForNode(link.dst);
    if (!vertices.has(a) || !vertices.has(b)) return;
    addUndirectedLayoutEdge(adj, a, b);
  });

  const terminalKeys = logicalLayouts.map(item => `logical:${item.logicalId}`);
  const graphLayout = layoutConnectivityGraph(vertices, adj, terminalKeys);
  const logicalBoxes = [];

  vertices.forEach((vertex, key) => {
    const placement = graphLayout.placements.get(key);
    if (!placement) return;

    if (vertex.kind === 'fabric') {
      pos.set(Number(vertex.node.id), {
        x: placement.x,
        y: placement.y,
        type: vertex.node.type || 'rnic'
      });
      return;
    }

    const item = logicalById.get(String(vertex.item.logicalId));
    const x = placement.x;
    const logicalY = placement.y;
    const nicY = logicalY - item.nodeCardHeight / 2 - 3 - item.nicCardHeight / 2;
    const totalNicWidth = item.nics.reduce((sum, nic) => sum + nic.width, 0) +
      Math.max(0, item.nics.length - 1) * item.nicGap;
    let nicCursor = x - totalNicWidth / 2;

    const nics = item.nics.map(nic => {
      const nicX = nicCursor + nic.width / 2;
      const endpoints = nic.endpoints;
      const epGap = endpoints.length > 1
        ? Math.min(item.planeGap, (nic.width - 18) / (endpoints.length - 1))
        : 0;
      const epStart = nicX - ((endpoints.length - 1) * epGap) / 2;

      endpoints.forEach((ep, index) => {
        const ex = epStart + index * epGap;
        const ey = nicY - item.nicCardHeight / 2;
        ep._x = ex;
        ep._y = ey;
        pos.set(Number(ep.carrierNodeId), {
          x: ex,
          y: ey,
          type: 'rnic',
          endpointToken: ep.token,
          logicalId: ep.logicalId,
          planeId: ep.planeId,
          rnicGroupId: ep.rnicGroupId
        });
      });

      nicCursor += nic.width + item.nicGap;
      return {
        ...nic,
        x: nicX,
        y: nicY,
        height: item.nicCardHeight
      };
    });

    logicalBoxes.push({
      logicalId: item.logicalId,
      label: item.label,
      x,
      y: logicalY,
      width: item.width,
      nodeCardWidth: Math.max(48, Math.min(68, 38 + String(item.label).length * 3)),
      nodeCardHeight: item.nodeCardHeight,
      endpoints: item.endpoints,
      nics
    });
  });

  return {
    pos,
    width: graphLayout.width,
    height: graphLayout.height,
    logicalBoxes,
    logicalEndpointView: true
  };
}

function layoutHierarchy(topology) {
  if (hasLogicalEndpointView(topology)) {
    return layoutLogicalEndpointTopology(topology);
  }

  const nodes = topology.nodes || [];
  const links = topology.links || [];
  const vertices = new Map();
  const adj = new Map();
  const pos = new Map();

  nodes.forEach(node => {
    const key = `node:${node.id}`;
    vertices.set(key, {
      key,
      kind: 'fabric',
      width: node.type === 'eps' ? 72 : 68,
      node
    });
    adj.set(key, new Set());
  });

  links.forEach(link => {
    const a = `node:${link.src}`;
    const b = `node:${link.dst}`;
    if (!vertices.has(a) || !vertices.has(b)) return;
    addUndirectedLayoutEdge(adj, a, b);
  });

  // In a topology without logical-node metadata, graph leaves are treated as
  // endpoints. Device type does not determine the hierarchy.
  const terminalKeys = Array.from(vertices.keys()).filter(key => (adj.get(key)?.size || 0) <= 1);
  const graphLayout = layoutConnectivityGraph(vertices, adj, terminalKeys);

  vertices.forEach((vertex, key) => {
    const placement = graphLayout.placements.get(key);
    if (!placement) return;
    pos.set(Number(vertex.node.id), {
      x: placement.x,
      y: placement.y,
      type: vertex.node.type || 'rnic'
    });
  });

  return {
    pos,
    width: graphLayout.width,
    height: graphLayout.height
  };
}


function buildTimeIntervals(schedule) {
  if (schedule.mode === 'map') {
    return [{
      interval: 0,
      slice: 'map',
      startNs: null,
      stableEndNs: null,
      connections: schedule.entries || []
    }];
  }

  const cfgs = schedule.configs || [];
  if (!cfgs.length) return [];

  const minSliceNs = Math.min(...cfgs.map(c => c.sliceDurationNs));
  const primaryCfgs = cfgs.filter(c => c.sliceDurationNs === minSliceNs);

  const maxSlices = Math.max(...primaryCfgs.map(c => c.numSlices));
  const entries = schedule.entries || [];

  function activeConnectionsAt(timeNs) {
    const list = [];

    cfgs.forEach(cfg => {
      const rel = timeNs - cfg.epochStartNs;
      if (rel < 0) return;

      const period = cfg.periodNs;
      const within = ((rel % period) + period) % period;
      const sliceIdx = Math.floor(within / cfg.sliceDurationNs);
      const sliceStart = cfg.epochStartNs + sliceIdx * cfg.sliceDurationNs;
      const stableEnd = sliceStart + cfg.sliceDurationNs - cfg.switchingTimeNs;

      if (timeNs >= sliceStart && timeNs < stableEnd) {
        entries
          .filter(e => e.ocs === cfg.ocs && e.slice === sliceIdx)
          .forEach(e => list.push({...e}));
      }
    });

    return list;
  }

  const intervals = [];

  for (let sl = 0; sl < maxSlices; sl++) {
    const starts = primaryCfgs.map(cfg => cfg.epochStartNs + sl * cfg.sliceDurationNs);

    const ends = primaryCfgs.map(cfg => {
      const st = cfg.epochStartNs + sl * cfg.sliceDurationNs;
      return st + cfg.sliceDurationNs - cfg.switchingTimeNs;
    });

    const startNs = Math.min(...starts);
    const stableEndNs = Math.min(...ends);

    if (!(stableEndNs > startNs)) continue;

    const mid = Math.floor((startNs + stableEndNs) / 2);
    const connections = activeConnectionsAt(mid);

    intervals.push({
      interval: intervals.length,
      slice: sl,
      startNs,
      stableEndNs,
      connections
    });
  }

  return intervals;
}

function buildActiveOcsMap(connections) {
  const map = new Map();

  (connections || []).forEach(c => {
    if (!map.has(c.ocs)) {
      map.set(c.ocs, []);
    }
    map.get(c.ocs).push(c);
  });

  return map;
}

function endpointKeyForOcsPort(ocs, port) {
  return `ocs:${ocs}:${port}`;
}

function endpointKeyForNode(node) {
  return `node:${node}`;
}

function addGraphEdge(graph, a, b) {
  if (!graph.has(a)) graph.set(a, new Set());
  if (!graph.has(b)) graph.set(b, new Set());
  graph.get(a).add(b);
  graph.get(b).add(a);
}

function componentPalette(idx) {
  const palette = [
    '#3f86b8',
    '#c06c84',
    '#6b9f4a',
    '#a66bbe',
    '#d08c3f',
    '#3fa0a0',
    '#b84f6b',
    '#7c8f3a',
    '#8d6e63',
    '#607d8b'
  ];

  return palette[idx % palette.length];
}

function buildOpticalComponents(topology, connections) {
  const portMap = topology.ocsPortToNeighbor || {};
  const ocsSet = new Set((topology.ocs || []).map(Number));
  const graph = new Map();

  // 1. OCS 内部 active port-pair，例如 OCS3 2↔3
  (connections || []).forEach(c => {
    const a = endpointKeyForOcsPort(c.ocs, c.a);
    const b = endpointKeyForOcsPort(c.ocs, c.b);
    addGraphEdge(graph, a, b);
  });

  // 2. OCS port 到物理邻居。OCS-OCS 之间要连接对端 OCS port。
  (connections || []).forEach(c => {
    [c.a, c.b].forEach(port => {
      const selfKey = endpointKeyForOcsPort(c.ocs, port);
      const peer = portMap[`${c.ocs}:${port}`];

      if (!peer) return;

      if (ocsSet.has(peer.node)) {
        const peerKey = endpointKeyForOcsPort(peer.node, peer.peer_port);
        addGraphEdge(graph, selfKey, peerKey);
      } else {
        const peerKey = endpointKeyForNode(peer.node);
        addGraphEdge(graph, selfKey, peerKey);
      }
    });
  });

  const componentOf = new Map();
  let cid = 0;

  Array.from(graph.keys()).forEach(start => {
    if (componentOf.has(start)) return;

    const queue = [start];
    componentOf.set(start, cid);

    while (queue.length) {
      const u = queue.shift();
      (graph.get(u) || []).forEach(v => {
        if (!componentOf.has(v)) {
          componentOf.set(v, cid);
          queue.push(v);
        }
      });
    }

    cid += 1;
  });

  return componentOf;
}

function colorForConnectionComponent(componentOf, conn) {
  const key = endpointKeyForOcsPort(conn.ocs, conn.a);
  const cid = componentOf.has(key) ? componentOf.get(key) : 0;
  return componentPalette(cid);
}

function colorForMapping(conn, idx) {
  const palette = [
    '#3f86b8',
    '#c06c84',
    '#6b9f4a',
    '#a66bbe',
    '#d08c3f',
    '#3fa0a0',
    '#b84f6b',
    '#7c8f3a'
  ];

  const a = Math.min(conn.a, conn.b);
  const b = Math.max(conn.a, conn.b);
  const seed = `${conn.ocs}:${a}-${b}`;

  let h = 0;

  for (let i = 0; i < seed.length; i++) {
    h = (h * 33 + seed.charCodeAt(i)) >>> 0;
  }

  return palette[h % palette.length] || palette[idx % palette.length];
}


function fallbackPortAngle(port) {
  const p = Number(port) || 0;
  const angles = [-Math.PI / 2, Math.PI / 2, 0, Math.PI, -Math.PI / 4, Math.PI / 4, -3 * Math.PI / 4, 3 * Math.PI / 4];
  return angles[p % angles.length];
}

function ocsPortAnchor(pos, portMap, ocsId, port, radius) {
  const center = pos.get(ocsId);
  if (!center) return null;

  const peer = portMap[`${ocsId}:${port}`];
  const peerPos = peer ? pos.get(peer.node) : null;
  let dx = 0;
  let dy = 0;

  if (peerPos) {
    dx = peerPos.x - center.x;
    dy = peerPos.y - center.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    dx /= len;
    dy /= len;
  } else {
    const a = fallbackPortAngle(port);
    dx = Math.cos(a);
    dy = Math.sin(a);
  }

  return {
    x: center.x + dx * radius,
    y: center.y + dy * radius
  };
}

function renderActiveExternalSegments(pos, portMap, conn, color) {
  const center = pos.get(conn.ocs);
  if (!center) return '';

  return [conn.a, conn.b].map(port => {
    const peer = portMap[`${conn.ocs}:${port}`];
    if (!peer) return '';

    const peerPos = pos.get(peer.node);
    if (!peerPos) return '';

    // Keep the historical topology rendering behavior: active circuits are
    // highlighted by coloring the existing physical edge segments up to the
    // OCS node, while the actual OCS port-pair is shown as a text annotation
    // above the OCS. Do not draw an internal line inside the device icon.
    return `<line
      class="link-active-colored topology-edge"
      data-src-node="${peer.node}"
      data-dst-node="${conn.ocs}"
      style="stroke:${color}"
      x1="${peerPos.x}"
      y1="${peerPos.y}"
      x2="${center.x}"
      y2="${center.y}"
    />`;
  }).join('');
}

function renderSliceTopology(exp) {
  const topology = exp.topology || {};
  const schedule = exp.schedule || {};
  const intervals = buildTimeIntervals(schedule);
  const root = document.getElementById('sliceTopology');

  if (!intervals.length) {
    root.innerHTML = '<p class="muted">No schedule intervals.</p>';
    return;
  }

  root.innerHTML = intervals.map(interval => renderOneInterval(topology, interval)).join('');
  initializeTopologyInteractions(root);
}

function initializeTopologyInteractions(root) {
  root.querySelectorAll('.interval-panel').forEach(panel => {
    const viewport = panel.querySelector('.topology-viewport');
    const svg = panel.querySelector('.topology-svg');
    const zoomLabel = panel.querySelector('.topology-zoom-label');

    if (!viewport || !svg) return;

    const baseWidth = Number(svg.getAttribute('width')) || 1;
    const baseHeight = Number(svg.getAttribute('height')) || 1;
    const contentOffsetX = Number(svg.dataset.contentOffsetX || 0);
    const contentOffsetY = Number(svg.dataset.contentOffsetY || 0);
    const contentWidth = Number(svg.dataset.contentWidth || baseWidth);
    const contentHeight = Number(svg.dataset.contentHeight || baseHeight);
    const minZoom = 0.5;
    const maxZoom = 3.0;
    const zoomStep = 0.2;
    let zoom = 1.0;

    /*
     * Keep the visible time-slice panel height independent from zoom.
     * Only the SVG content changes size; the viewport remains stable and
     * becomes scrollable when the topology is larger than the viewport.
     */
    const initialViewportHeight = Math.min(
      520,
      Math.max(210, Math.ceil(contentHeight))
    );
    viewport.style.height = `${initialViewportHeight}px`;

    const nodePositions = new Map();

    svg.querySelectorAll('[data-node-id][data-node-x][data-node-y]').forEach(el => {
      const nodeId = Number(el.dataset.nodeId);
      if (!Number.isFinite(nodeId)) return;

      nodePositions.set(nodeId, {
        x: Number(el.dataset.nodeX),
        y: Number(el.dataset.nodeY),
        initialX: Number(el.dataset.nodeX),
        initialY: Number(el.dataset.nodeY)
      });
    });

    const refreshEdgesAndAnnotations = () => {
      svg.querySelectorAll('.topology-edge[data-src-node][data-dst-node]').forEach(line => {
        const src = nodePositions.get(Number(line.dataset.srcNode));
        const dst = nodePositions.get(Number(line.dataset.dstNode));

        if (!src || !dst) return;

        line.setAttribute('x1', src.x);
        line.setAttribute('y1', src.y);
        line.setAttribute('x2', dst.x);
        line.setAttribute('y2', dst.y);
      });

      svg.querySelectorAll('.port-annotation[data-node-id]').forEach(label => {
        const p = nodePositions.get(Number(label.dataset.nodeId));
        if (!p) return;

        label.setAttribute('x', p.x);
        label.setAttribute('y', p.y + Number(label.dataset.offsetY || 0));
      });
    };

    const applyZoom = (nextZoom, preserveCenter = true) => {
      const previousWidth = svg.getBoundingClientRect().width || baseWidth;
      const centerRatioX = previousWidth > 0
        ? (viewport.scrollLeft + viewport.clientWidth / 2) / previousWidth
        : 0.5;
      const previousHeight = svg.getBoundingClientRect().height || 1;
      const centerRatioY = previousHeight > 0
        ? (viewport.scrollTop + viewport.clientHeight / 2) / previousHeight
        : 0.5;

      zoom = Math.max(minZoom, Math.min(maxZoom, nextZoom));
      svg.style.width = `${Math.round(baseWidth * zoom)}px`;
      svg.style.height = `${Math.round(baseHeight * zoom)}px`;

      if (zoomLabel) {
        zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
      }

      requestAnimationFrame(() => {
        if (preserveCenter) {
          viewport.scrollLeft = centerRatioX * svg.getBoundingClientRect().width - viewport.clientWidth / 2;
          viewport.scrollTop = centerRatioY * svg.getBoundingClientRect().height - viewport.clientHeight / 2;
          return;
        }

        // The SVG includes a large drag workspace around the automatically
        // laid-out topology. Start each slice centered on the actual content,
        // rather than on the empty top-left workspace.
        viewport.scrollLeft = (contentOffsetX + contentWidth / 2) * zoom - viewport.clientWidth / 2;
        viewport.scrollTop = (contentOffsetY + contentHeight / 2) * zoom - viewport.clientHeight / 2;
      });
    };

    panel.querySelectorAll('[data-topology-action]').forEach(button => {
      button.addEventListener('click', () => {
        const action = button.dataset.topologyAction;

        if (action === 'zoom-in') applyZoom(zoom + zoomStep);
        if (action === 'zoom-out') applyZoom(zoom - zoomStep);
        if (action === 'zoom-reset') applyZoom(1.0);

        if (action === 'layout-reset') {
          svg.querySelectorAll('.topology-draggable').forEach(group => {
            group.dataset.translateX = '0';
            group.dataset.translateY = '0';
            group.removeAttribute('transform');
          });

          nodePositions.forEach(p => {
            p.x = p.initialX;
            p.y = p.initialY;
          });

          refreshEdgesAndAnnotations();
        }
      });
    });

    viewport.addEventListener('wheel', event => {
      if (!event.ctrlKey && !event.metaKey) return;

      event.preventDefault();
      applyZoom(zoom + (event.deltaY < 0 ? zoomStep : -zoomStep));
    }, {passive: false});

    svg.querySelectorAll('.topology-draggable').forEach(group => {
      group.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;

        const ctm = svg.getScreenCTM();
        if (!ctm) return;

        const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());
        const nodeIds = String(group.dataset.dragNodeIds || '')
          .split(',')
          .map(v => Number(v))
          .filter(Number.isFinite);

        const startPositions = new Map();
        nodeIds.forEach(nodeId => {
          const p = nodePositions.get(nodeId);
          if (p) startPositions.set(nodeId, {x: p.x, y: p.y});
        });

        const baseTranslateX = Number(group.dataset.translateX || 0);
        const baseTranslateY = Number(group.dataset.translateY || 0);

        group.classList.add('is-dragging');
        group.setPointerCapture(event.pointerId);
        event.preventDefault();
        event.stopPropagation();

        const onPointerMove = moveEvent => {
          // Auto-scroll the fixed viewport while a node is dragged near an
          // edge. Combined with the padded SVG workspace, this allows nodes
          // to be moved far beyond the original automatic-layout area.
          const viewportRect = viewport.getBoundingClientRect();
          const edgeZone = 42;
          const maxScrollStep = 26;
          let scrollDx = 0;
          let scrollDy = 0;

          if (moveEvent.clientX < viewportRect.left + edgeZone) {
            scrollDx = -maxScrollStep * (1 - Math.max(0, moveEvent.clientX - viewportRect.left) / edgeZone);
          } else if (moveEvent.clientX > viewportRect.right - edgeZone) {
            scrollDx = maxScrollStep * (1 - Math.max(0, viewportRect.right - moveEvent.clientX) / edgeZone);
          }

          if (moveEvent.clientY < viewportRect.top + edgeZone) {
            scrollDy = -maxScrollStep * (1 - Math.max(0, moveEvent.clientY - viewportRect.top) / edgeZone);
          } else if (moveEvent.clientY > viewportRect.bottom - edgeZone) {
            scrollDy = maxScrollStep * (1 - Math.max(0, viewportRect.bottom - moveEvent.clientY) / edgeZone);
          }

          if (scrollDx || scrollDy) {
            viewport.scrollLeft += scrollDx;
            viewport.scrollTop += scrollDy;
          }

          const moveCtm = svg.getScreenCTM();
          if (!moveCtm) return;

          const current = new DOMPoint(moveEvent.clientX, moveEvent.clientY)
            .matrixTransform(moveCtm.inverse());
          const dx = current.x - point.x;
          const dy = current.y - point.y;
          const translateX = baseTranslateX + dx;
          const translateY = baseTranslateY + dy;

          group.dataset.translateX = String(translateX);
          group.dataset.translateY = String(translateY);
          group.setAttribute('transform', `translate(${translateX} ${translateY})`);

          startPositions.forEach((start, nodeId) => {
            const p = nodePositions.get(nodeId);
            if (!p) return;
            p.x = start.x + dx;
            p.y = start.y + dy;
          });

          refreshEdgesAndAnnotations();
        };

        const finishDrag = () => {
          group.classList.remove('is-dragging');
          group.removeEventListener('pointermove', onPointerMove);
          group.removeEventListener('pointerup', finishDrag);
          group.removeEventListener('pointercancel', finishDrag);
        };

        group.addEventListener('pointermove', onPointerMove);
        group.addEventListener('pointerup', finishDrag);
        group.addEventListener('pointercancel', finishDrag);
      });
    });

    applyZoom(1.0, false);
    refreshEdgesAndAnnotations();
  });
}

function renderOneInterval(topology, interval) {
  const layout = layoutHierarchy(topology);
  const {pos, width, height} = layout;
  const logicalBoxes = layout.logicalBoxes || [];
  const logicalEndpointView = !!layout.logicalEndpointView;
  const links = topology.links || [];
  const portMap = topology.ocsPortToNeighbor || {};
  const activeByOcs = buildActiveOcsMap(interval.connections || []);
  const componentOf = buildOpticalComponents(topology, interval.connections || []);

  const physical = links.map(l => {
    const a = pos.get(l.src);
    const b = pos.get(l.dst);

    if (!a || !b) return '';

    return `<line
      class="link-physical topology-edge"
      data-src-node="${l.src}"
      data-dst-node="${l.dst}"
      x1="${a.x}"
      y1="${a.y}"
      x2="${b.x}"
      y2="${b.y}"
    />`;
  }).join('');

  const activeExternalLines = (interval.connections || []).map(c => {
    const color = colorForConnectionComponent(componentOf, c);
    return renderActiveExternalSegments(pos, portMap, c, color);
  }).join('');


  const fabricNodeEls = (topology.nodes || [])
    .filter(n => !(logicalEndpointView && n.type === 'rnic'))
    .map(n => {
      const p = pos.get(n.id);

      if (!p) return '';

      if (n.type === 'ocs') {
        return `
          <g
            class="node-group node-group-ocs topology-draggable"
            data-drag-node-ids="${n.id}"
            data-node-id="${n.id}"
            data-node-x="${p.x}"
            data-node-y="${p.y}"
          >
            <title>OCS ${n.id}</title>
            <rect class="node-ocs" x="${p.x - 14}" y="${p.y - 14}" width="28" height="28" rx="5" transform="rotate(45 ${p.x} ${p.y})"/>
            <text class="node-label node-label-ocs" x="${p.x}" y="${p.y}">O${n.id}</text>
          </g>
        `;
      }

      if (n.type === 'eps') {
        return `
          <g
            class="node-group node-group-eps topology-draggable"
            data-drag-node-ids="${n.id}"
            data-node-id="${n.id}"
            data-node-x="${p.x}"
            data-node-y="${p.y}"
          >
            <title>EPS ${n.id}</title>
            <rect class="node-eps" x="${p.x - 19}" y="${p.y - 11}" width="38" height="22" rx="7"/>
            <text class="node-label node-label-eps" x="${p.x}" y="${p.y}">E${n.id}</text>
          </g>
        `;
      }

      return `
        <g
          class="node-group node-group-host topology-draggable"
          data-drag-node-ids="${n.id}"
          data-node-id="${n.id}"
          data-node-x="${p.x}"
          data-node-y="${p.y}"
        >
          <circle class="node-rnic" cx="${p.x}" cy="${p.y}" r="12"/>
          <text class="node-label node-label-host" x="${p.x}" y="${p.y}">H${n.id}</text>
        </g>
      `;
    }).join('');

  const logicalNodeEls = logicalBoxes.map(box => {
    const nicEls = (box.nics || []).map(nic => {
      const endpointEls = (nic.endpoints || []).map(ep => {
        const p = pos.get(Number(ep.carrierNodeId));
        if (!p) return '';
        const label = ep.label || `P${ep.planeId}`;
        const title = `Endpoint ${ep.token}
Logical node: ${ep.logicalId}
NIC: ${ep.rnicGroupId}
Plane: ${ep.planeId}
Carrier RNIC: ${ep.carrierNodeId}`;

        return `
          <g
            class="logical-endpoint-port"
            data-node-id="${ep.carrierNodeId}"
            data-node-x="${p.x}"
            data-node-y="${p.y}"
          >
            <title>${escapeHtml(title)}</title>
            <circle class="endpoint-port-dot" cx="${p.x}" cy="${p.y}" r="4"/>
            <text class="endpoint-port-label" x="${p.x}" y="${p.y + 9}">${escapeHtml(label)}</text>
          </g>
        `;
      }).join('');

      const nicBottomY = nic.y + nic.height / 2;
      const nodeTopY = box.y - box.nodeCardHeight / 2;

      return `
        <g class="logical-nic-group">
          <line class="logical-nic-link" x1="${nic.x}" y1="${nicBottomY}" x2="${box.x}" y2="${nodeTopY}"/>
          <rect class="logical-nic-card" x="${nic.x - nic.width / 2}" y="${nic.y - nic.height / 2}" width="${nic.width}" height="${nic.height}" rx="6"/>
          <text class="logical-nic-title" x="${nic.x}" y="${nic.y + 7}">NIC ${nic.nicId}</text>
          ${endpointEls}
        </g>
      `;
    }).join('');

    const carrierNodeIds = (box.endpoints || []).map(ep => Number(ep.carrierNodeId)).join(',');

    return `
      <g
        class="logical-node-group topology-draggable"
        data-drag-node-ids="${carrierNodeIds}"
      >
        <title>${escapeHtml(box.label)}</title>
        <rect class="logical-node-card" x="${box.x - box.nodeCardWidth / 2}" y="${box.y - box.nodeCardHeight / 2}" width="${box.nodeCardWidth}" height="${box.nodeCardHeight}" rx="6"/>
        <text class="logical-node-title" x="${box.x}" y="${box.y}">${escapeHtml(box.label)}</text>
        ${nicEls}
      </g>
    `;
  }).join('');

  const nodeEls = fabricNodeEls + logicalNodeEls;

  const portAnnotations = (topology.nodes || [])
    .filter(n => n.type === 'ocs')
    .map(n => {
      const p = pos.get(n.id);
      const pairs = activeByOcs.get(n.id) || [];

      if (!p || !pairs.length) return '';

      return pairs.map((c, idx) => {
        const color = colorForConnectionComponent(componentOf, c);
        const offsetY = -22 - idx * 10;
        return `<text
          class="port-annotation"
          data-node-id="${n.id}"
          data-offset-y="${offsetY}"
          style="fill:${color}"
          x="${p.x}"
          y="${p.y + offsetY}"
        >${c.a}↔${c.b}</text>`;
      }).join('');
    }).join('');

  const mappingLegend = (interval.connections || []).map(c => {
    const color = colorForConnectionComponent(componentOf, c);

    return `<span class="mapping-chip"><span class="mapping-swatch" style="background:${color}"></span>O${c.ocs} ${c.a}↔${c.b}</span>`;
  }).join('');

  const title = interval.slice === 'map' ? 'Fixed Map' : `Slice ${interval.slice}`;
  const timeLabel = interval.slice === 'map'
    ? 'static'
    : `${fmtNs(interval.startNs)} – ${fmtNs(interval.stableEndNs)}`;

  // Keep a substantial workspace around the automatic layout so nodes can be
  // rearranged well beyond their original positions without being clipped by
  // the SVG boundary. The viewport starts centered on the actual topology.
  const dragPaddingX = Math.max(360, Math.min(900, Math.round(width * 0.6)));
  const dragPaddingY = Math.max(240, Math.min(600, Math.round(height * 0.8)));
  const canvasWidth = width + dragPaddingX * 2;
  const canvasHeight = height + dragPaddingY * 2;

  const topologyLegend = logicalEndpointView
    ? `
      <span><span class="legend-shape legend-plane"></span>Plane</span>
      <span><span class="legend-shape legend-nic"></span>NIC</span>
      <span><span class="legend-shape legend-node"></span>Node</span>
      <span><span class="legend-shape legend-eps"></span>EPS</span>
      <span><span class="legend-shape legend-ocs"></span>OCS</span>
    `
    : `
      <span><span class="legend-shape legend-host"></span>RNIC</span>
      <span><span class="legend-shape legend-eps"></span>EPS</span>
      <span><span class="legend-shape legend-ocs"></span>OCS</span>
    `;

  return `
    <div class="slice-panel interval-panel">
      <div class="slice-title">
        <span>${title}</span>
        <span>${timeLabel}</span>
      </div>
      <div class="mapping-legend">${mappingLegend}</div>
      <div class="topology-toolbar" aria-label="Topology controls">
        <button type="button" class="topology-tool-button" data-topology-action="zoom-out" title="Zoom out">−</button>
        <button type="button" class="topology-zoom-label" data-topology-action="zoom-reset" title="Reset zoom">100%</button>
        <button type="button" class="topology-tool-button" data-topology-action="zoom-in" title="Zoom in">+</button>
        <button type="button" class="topology-reset-layout" data-topology-action="layout-reset" title="Reset dragged node positions">Reset layout</button>
      </div>
      <div
        class="topology-viewport"
        tabindex="0"
        aria-label="${escapeHtml(`${title} topology. Scroll, zoom, or drag nodes to inspect the topology.`)}"
      >
        <svg
          class="topology-svg"
          viewBox="0 0 ${canvasWidth} ${canvasHeight}"
          width="${canvasWidth}"
          height="${canvasHeight}"
          data-content-offset-x="${dragPaddingX}"
          data-content-offset-y="${dragPaddingY}"
          data-content-width="${width}"
          data-content-height="${height}"
          role="img"
          aria-label="${escapeHtml(`${title} topology`)}"
        >
          <g class="topology-canvas" transform="translate(${dragPaddingX} ${dragPaddingY})">
            ${physical}
            ${activeExternalLines}
            ${nodeEls}
            ${portAnnotations}
          </g>
        </svg>
      </div>
      <div class="topology-node-legend">
        ${topologyLegend}
      </div>
    </div>
  `;
}

function renderThroughput(exp) {
  const series = exp.throughput || [];
  const root = document.getElementById('throughputChart');
  const legend = document.getElementById('throughputLegend');

  if (!series.length) {
    root.innerHTML = '<p class="muted">No throughput series.</p>';
    legend.innerHTML = '';
    return;
  }

  const normalize = document.getElementById('normalizeTime').checked;
  const allPts = series.flatMap(s => {
    const pts = s.points || [];
    if (!pts.length) return [];

    const sorted = pts.slice().sort((a, b) => a.timeNs - b.timeNs);
    const bucketNs = s.bucketNs || inferBucketNs(sorted);
    const last = sorted[sorted.length - 1];

    // Include the synthetic baseline endpoint in the x-axis range so that
    // a flow can visually return to 0 after its last sampled bucket.
    return sorted.concat([{
      timeNs: last.timeNs + bucketNs,
      throughputGbps: 0
    }]);
  });
  const minT = Math.min(...allPts.map(p => p.timeNs));
  const maxT = Math.max(...allPts.map(p => p.timeNs));
  const maxY = Math.max(0.001, ...allPts.map(p => p.throughputGbps || 0));

  const w = 980;
  const h = 310;
  const m = {
    l: 58,
    r: 24,
    t: 24,
    b: 44
  };

  const plotW = w - m.l - m.r;
  const plotH = h - m.t - m.b;

  const domainMin = normalize ? minT : 0;
  const domainMax = maxT;

  const x = t => {
    return m.l + (t - domainMin) / Math.max(1, domainMax - domainMin) * plotW;
  };

  const y = v => {
    return m.t + (1 - v / maxY) * plotH;
  };

  const grid = [];

  for (let i = 0; i <= 5; i++) {
    const yy = m.t + i / 5 * plotH;
    const val = maxY * (1 - i / 5);

    grid.push(`<line class="gridline" x1="${m.l}" y1="${yy}" x2="${w - m.r}" y2="${yy}"/>`);
    grid.push(`<text class="axis-label" x="${m.l - 8}" y="${yy + 4}" text-anchor="end">${val.toFixed(2)}</text>`);
  }

  for (let i = 0; i <= 5; i++) {
    const xx = m.l + i / 5 * plotW;
    const tickTimeNs = domainMin + i / 5 * (domainMax - domainMin);
    const labelNs = normalize ? tickTimeNs - minT : tickTimeNs;

    grid.push(`<line class="gridline" x1="${xx}" y1="${m.t}" x2="${xx}" y2="${h - m.b}"/>`);
    grid.push(`<text class="axis-label" x="${xx}" y="${h - 18}" text-anchor="middle">${fmtNs(Math.round(labelNs))}</text>`);
  }

  function inferBucketNs(points) {
    if (!points || points.length < 2) return 1;

    const times = Array.from(new Set(points.map(p => p.timeNs))).sort((a, b) => a - b);
    let best = null;

    for (let i = 1; i < times.length; i++) {
      const d = times[i] - times[i - 1];
      if (d > 0 && (best === null || d < best)) {
        best = d;
      }
    }

    return best || 1;
  }

  function buildStepPath(points, bucketNs) {
    if (!points || !points.length) return '';

    const sorted = points.slice().sort((a, b) => a.timeNs - b.timeNs);
    const b = bucketNs || inferBucketNs(sorted);

    const first = sorted[0];

    let d = `M ${x(first.timeNs).toFixed(1)} ${y(0).toFixed(1)}`;
    d += ` V ${y(first.throughputGbps || 0).toFixed(1)}`;

    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];

      const prevEnd = prev.timeNs + b;

      // If there is a missing bucket, drop to zero during the gap.
      if (cur.timeNs > prevEnd + b * 0.5) {
        d += ` H ${x(prevEnd).toFixed(1)} V ${y(0).toFixed(1)}`;
        d += ` H ${x(cur.timeNs).toFixed(1)} V ${y(cur.throughputGbps || 0).toFixed(1)}`;
      } else {
        d += ` H ${x(cur.timeNs).toFixed(1)} V ${y(cur.throughputGbps || 0).toFixed(1)}`;
      }
    }

    const last = sorted[sorted.length - 1];
    const endTime = last.timeNs + b;

    d += ` H ${x(endTime).toFixed(1)} V ${y(0).toFixed(1)}`;

    return d;
  }

  const lines = series.map((s, idx) => {
    if (hiddenThroughputSeries.has(idx)) return '';

    const color = COLORS[idx % COLORS.length];
    const d = buildStepPath(s.points || [], s.bucketNs);

    return `<path class="flow-line" d="${d}" stroke="${color}"/>`;
  }).join('');

  root.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" role="img">
      ${grid.join('')}
      <line class="axis" x1="${m.l}" y1="${h - m.b}" x2="${w - m.r}" y2="${h - m.b}"/>
      <line class="axis" x1="${m.l}" y1="${m.t}" x2="${m.l}" y2="${h - m.b}"/>
      <text class="axis-label" x="${m.l}" y="${h - 3}">${normalize ? 'time since first flow' : 'time'}</text>
      <text class="axis-label" x="12" y="${m.t + 8}" transform="rotate(-90 12 ${m.t + 8})">Gbps</text>
      ${lines}
    </svg>
  `;

  legend.innerHTML = series.map((s, idx) => {
    const visibleParts = [s.label || '-'];

    if (s.sport !== null && s.sport !== undefined) visibleParts.push(`sport=${s.sport}`);
    if (s.dport !== null && s.dport !== undefined) visibleParts.push(`dport=${s.dport}`);
    if (s.pg !== null && s.pg !== undefined) visibleParts.push(`priorityG=${s.pg}`);

    const detailParts = [];
    const fctAvg = s.fctAvgThroughputGbps ?? s.avgThroughputGbps;
    const activeAvg = s.activeAvgThroughputGbps;

    if (fctAvg !== null && fctAvg !== undefined) detailParts.push(`FCT avg ${fmtGbps(fctAvg)}`);
    if (activeAvg !== null && activeAvg !== undefined) detailParts.push(`active avg ${fmtGbps(activeAvg)}`);

    const isVisible = !hiddenThroughputSeries.has(idx);
    const detail = detailParts.join(' · ');
    const title = escapeHtml(`${isVisible ? 'Click to hide' : 'Click to show'}${detail ? ` · ${detail}` : ''}`);
    const visibleLabel = visibleParts.join(' ');

    return `
      <div
        class="legend-item ${isVisible ? '' : 'is-hidden'}"
        data-series-index="${idx}"
        role="button"
        tabindex="0"
        aria-pressed="${isVisible}"
        title="${title}"
      >
        <span class="legend-swatch" style="background:${COLORS[idx % COLORS.length]}"></span>
        ${escapeHtml(visibleLabel)}
      </div>
    `;
  }).join('');

  legend.querySelectorAll('.legend-item').forEach(item => {
    const toggleSeries = () => {
      const idx = Number(item.dataset.seriesIndex);

      if (hiddenThroughputSeries.has(idx)) {
        hiddenThroughputSeries.delete(idx);
      } else {
        hiddenThroughputSeries.add(idx);
      }

      renderThroughput(exp);
    };

    item.addEventListener('click', toggleSeries);
    item.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggleSeries();
      }
    });
  });
}

function renderTable(rootId, columns, rows) {
  const root = document.getElementById(rootId);

  if (!root) {
    console.warn(`Missing table root: ${rootId}`);
    return;
  }

  if (!rows || !rows.length) {
    root.innerHTML = '<p class="muted">No data.</p>';
    return;
  }

  root.innerHTML = `
    <table>
      <thead>
        <tr>${columns.map(c => `<th>${escapeHtml(c.label)}</th>`).join('')}</tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            ${columns.map(c => {
              const raw = c.format ? c.format(r[c.key], r) : (r[c.key] ?? '-');
              return `<td>${c.html ? raw : escapeHtml(raw)}</td>`;
            }).join('')}
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderFlowResultTable(exp) {
  const rows = exp.flowResults || [];

  renderTable('flowResultTable', [
    {key: 'index', label: '#'},
    {key: 'display_src', label: 'src'},
    {key: 'display_dst', label: 'dst'},
    {key: 'src_carrier', label: 'src carrier'},
    {key: 'dst_carrier', label: 'dst carrier'},
    {key: 'route_cost', label: 'route cost'},
    {key: 'dport', label: 'dport'},
    {key: 'size_bytes', label: 'size', format: fmtBytes},
    {key: 'start_ns', label: 'start', format: fmtNs},
    {key: 'status', label: 'status', format: fmtStatus, html: true},
    {key: 'fct_ns', label: 'FCT', format: fmtOptionalNs},
    {key: 'finish_ns', label: 'finish', format: fmtOptionalNs},
    {key: 'avg_throughput_gbps', label: 'avg throughput', format: fmtOptionalGbps},
    {key: 'match_delta_ns', label: 'match Δ', format: fmtOptionalNs}
  ], rows);
}

function renderOcsStats(exp) {
  const rows = (exp.log && exp.log.ocsStats) || [];

  renderTable('ocsStatsTable', [
    {key: 'node', label: 'OCS'},
    {key: 'forwardedPackets', label: 'fwd pkts'},
    {key: 'forwardedBytes', label: 'fwd bytes'},
    {key: 'dropSwitching', label: 'sw drops'},
    {key: 'dropNoCircuit', label: 'no-circ drops'}
  ], rows);
}

function renderInjectionTable(exp) {
  const s = exp.summary || {};
  const tables = (exp.log && exp.log.injectionTables) || [];

  const mode = Number(
    s.injectionMode !== undefined && s.injectionMode !== null
      ? s.injectionMode
      : s.observedInjectionMode
  );

  if (mode === 0) {
    document.getElementById('injectionTable').innerHTML =
      '<p class="muted">Default RDMA mode: injection control is disabled.</p>';
    return;
  }

  const rows = tables.flatMap(t => (t.windows || []).map(w => ({
    rnicLabel: t.rnicLabel || String(t.rnic),
    rnicCarrier: t.rnic,
    window: w.window,
    startNs: w.startNs,
    endNs: w.endNs,
    dstLabels: (w.dstLabels && w.dstLabels.length ? w.dstLabels : (w.dstRnics || []).map(String)).join(', '),
    dstCarriers: (w.dstRnics || []).join(', ')
  })));

  renderTable('injectionTable', [
    {key: 'rnicLabel', label: 'RNIC endpoint'},
    {key: 'rnicCarrier', label: 'carrier'},
    {key: 'window', label: 'window'},
    {key: 'startNs', label: 'start', format: fmtNs},
    {key: 'endNs', label: 'end', format: fmtNs},
    {key: 'dstLabels', label: 'dst endpoints'},
    {key: 'dstCarriers', label: 'dst carriers'}
  ], rows);
}

function renderInjectionControlSummary(exp) {
  const s = exp.summary || {};
  const log = exp.log || {};
  const postSummary = log.userspacePostSummary || {};

  const rows = [
    {key: 'Mode', value: `${s.injectionMode ?? '-'} · ${s.injectionModeName || '-'}`},
    // {key: 'Layer', value: s.observedInjectionLayer || s.injectionLayer || '-'},
    {key: 'Flows Completed', value: `${s.fctCount ?? 0} / ${s.flowCount ?? 0}`},
    {key: 'Switching drops', value: s.totalDropSwitching ?? 0},
    {
      key: 'Retx summary',
      value: `${s.totalRecoverEvents ?? 0} events / ${s.totalRetxPackets ?? 0} packets / ${fmtBytes(s.totalRetxBytes ?? 0)}`
    }
  ];

  if (Number(s.injectionMode) === 2 || (postSummary.count || 0) > 0) {
    rows.push(
      {key: 'Userspace posts', value: postSummary.count ?? 0},
      {key: 'Posted bytes', value: fmtBytes(postSummary.totalBytes ?? 0)},
      {
        key: 'Avg post size',
        value: postSummary.avgBytes === null || postSummary.avgBytes === undefined
          ? '-'
          : fmtBytes(postSummary.avgBytes)
      },
      {key: 'First post', value: fmtOptionalNs(postSummary.firstPostTimeNs)},
      {key: 'Last post', value: fmtOptionalNs(postSummary.lastPostTimeNs)},
      {key: 'Safe-budget limited', value: postSummary.safeBudgetLimitedCount ?? 0}
    );
  }

  document.getElementById('injectionSummary').innerHTML = `
    <div class="kv-list">
      ${rows.map(r => `
        <div class="kv">
          <div class="key">${escapeHtml(r.key)}</div>
          <div class="value">${escapeHtml(r.value)}</div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderUserspacePostTable(exp) {
  const log = exp.log || {};
  const rows = log.userspacePosts || [];
  const byFlow = log.userspacePostByFlow || [];

  const card = document.getElementById('userspacePostSection');

  if (card) {
    card.style.display = rows.length || byFlow.length ? '' : 'none';
  }

  const total = log.userspacePostTotalEvents ?? rows.length;
  const shown = rows.length;

  const meta = document.getElementById('userspacePostMeta');
  if (meta) {
    meta.textContent = total > shown
      ? `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} post events. Summary is computed over all events.`
      : `Showing ${shown.toLocaleString()} post events.`;
  }

  const summaryRows = byFlow.map(r => ({
    ...r,
    srcDisplay: r.srcLabel || String(r.src),
    dstDisplay: r.dstLabel || String(r.dst),
    srcCarrier: r.src,
    dstCarrier: r.dst
  }));

  const eventRows = rows.map(r => ({
    ...r,
    srcDisplay: r.srcLabel || String(r.src),
    dstDisplay: r.dstLabel || String(r.dst),
    srcCarrier: r.src,
    dstCarrier: r.dst
  }));

  renderTable('userspacePostSummaryTable', [
    {key: 'srcDisplay', label: 'src endpoint'},
    {key: 'dstDisplay', label: 'dst endpoint'},
    {key: 'srcCarrier', label: 'src carrier'},
    {key: 'dstCarrier', label: 'dst carrier'},
    {key: 'sport', label: 'sport'},
    {key: 'dport', label: 'dport'},
    {key: 'postCount', label: 'posts'},
    {key: 'totalBytes', label: 'total posted', format: fmtBytes},
    {key: 'avgBytes', label: 'avg WR', format: fmtBytes},
    {key: 'minBytes', label: 'min WR', format: fmtBytes},
    {key: 'maxBytes', label: 'max WR', format: fmtBytes},
    {key: 'firstPostTimeNs', label: 'first post', format: fmtNs},
    {key: 'lastPostTimeNs', label: 'last post', format: fmtNs},
    {key: 'safeBudgetLimitedCount', label: 'budget-limited'}
  ], summaryRows);

  renderTable('userspacePostTable', [
    {key: 'timeNs', label: 'time', format: fmtNs},
    {key: 'srcDisplay', label: 'src endpoint'},
    {key: 'dstDisplay', label: 'dst endpoint'},
    {key: 'srcCarrier', label: 'src carrier'},
    {key: 'dstCarrier', label: 'dst carrier'},
    {key: 'sport', label: 'sport'},
    {key: 'dport', label: 'dport'},
    {key: 'bytes', label: 'WR bytes', format: fmtBytes},
    {key: 'postedLimit', label: 'posted limit', format: fmtBytes},
    {key: 'outstanding', label: 'outstanding', format: fmtBytes},
    {key: 'safeBudget', label: 'safe budget', format: fmtBytes},
    {key: 'windowEnd', label: 'window end', format: fmtNs}
  ], eventRows);
}

function renderRnicRetxTable(exp) {
  const rows = (exp.log && exp.log.rnicRetxByRnic) || [];

  const displayRows = rows.map(r => ({
    ...r,
    rnicDisplay: r.rnicLabel || String(r.rnic),
    rnicCarrier: r.rnic
  }));

  renderTable('rnicRetxTable', [
    {key: 'rnicDisplay', label: 'RNIC endpoint'},
    {key: 'rnicCarrier', label: 'carrier'},
    {key: 'flows', label: 'flows'},
    {key: 'recoverEvents', label: 'recover events'},
    {key: 'retxPackets', label: 'retx packets'},
    {key: 'retxBytes', label: 'retx bytes'}
  ], displayRows);
}

document.getElementById('experimentSearch').addEventListener('input', renderExperimentList);
document.getElementById('normalizeTime').addEventListener('change', () => renderThroughput(selectedExperiment));

loadData();

window.addEventListener('resize', () => {
  requestAnimationFrame(syncInjectionWindowHeight);
});

const controlPlaneObserver = new ResizeObserver(() => {
  requestAnimationFrame(syncInjectionWindowHeight);
});

window.addEventListener('load', () => {
  const left = document.querySelector('.control-plane-left');

  if (left) {
    controlPlaneObserver.observe(left);
  }

  requestAnimationFrame(syncInjectionWindowHeight);
});