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

function layoutLogicalEndpointTopology(topology) {
  const nodes = topology.nodes || [];
  const links = topology.links || [];
  const logicalNodes = (topology.logicalNodes || [])
    .slice()
    .sort((a, b) => Number(a.logicalId) - Number(b.logicalId));

  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const pos = new Map();
  const typeOf = id => nodeById.get(id)?.type || 'rnic';

  const ocsNodes = nodes.filter(n => n.type === 'ocs').slice().sort((a, b) => a.id - b.id);
  const epsNodes = nodes.filter(n => n.type === 'eps').slice().sort((a, b) => a.id - b.id);
  const ocsSet = new Set(ocsNodes.map(n => n.id));
  const ocsOcsLinks = links.filter(l => typeOf(l.src) === 'ocs' && typeOf(l.dst) === 'ocs');
  const ocsAdj = new Map();

  ocsNodes.forEach(n => ocsAdj.set(n.id, []));
  ocsOcsLinks.forEach(l => {
    ocsAdj.get(l.src)?.push(l.dst);
    ocsAdj.get(l.dst)?.push(l.src);
  });
  ocsAdj.forEach(list => list.sort((a, b) => a - b));

  function nonOcsDegree(id) {
    return links.filter(l => {
      if (l.src === id) return !ocsSet.has(l.dst);
      if (l.dst === id) return !ocsSet.has(l.src);
      return false;
    }).length;
  }

  const logicalBoxW = Math.max(140, Math.min(220, 92 + Math.max(0, ...logicalNodes.map(n => (n.endpoints || []).length)) * 46));
  const logicalGap = 72;
  const leftPad = 56;
  const canvasWidth = Math.max(
    560,
    leftPad * 2 + logicalNodes.length * logicalBoxW + Math.max(0, logicalNodes.length - 1) * logicalGap,
    leftPad * 2 + Math.max(1, ocsNodes.length) * 120
  );

  let maxOcsLevel = 0;

  if (ocsNodes.length) {
    let roots = ocsNodes
      .filter(o => nonOcsDegree(o.id) === 0 && (ocsAdj.get(o.id) || []).length > 0)
      .map(o => o.id)
      .sort((a, b) => a - b);

    if (!roots.length) {
      const best = ocsNodes
        .slice()
        .sort((a, b) => ((ocsAdj.get(b.id) || []).length - (ocsAdj.get(a.id) || []).length) || a.id - b.id)[0];
      roots = best ? [best.id] : [];
    }

    const level = new Map();
    const queue = [];

    roots.forEach(r => {
      level.set(r, 0);
      queue.push(r);
    });

    while (queue.length) {
      const u = queue.shift();
      (ocsAdj.get(u) || []).forEach(v => {
        if (!level.has(v)) {
          level.set(v, level.get(u) + 1);
          queue.push(v);
        }
      });
    }

    ocsNodes.forEach(o => {
      if (!level.has(o.id)) {
        level.set(o.id, 0);
      }
    });

    maxOcsLevel = Math.max(0, ...Array.from(level.values()));

    const byLevel = new Map();
    ocsNodes.forEach(o => {
      const lv = level.get(o.id) || 0;
      if (!byLevel.has(lv)) byLevel.set(lv, []);
      byLevel.get(lv).push(o.id);
    });

    byLevel.forEach((ids, lv) => {
      ids.sort((a, b) => a - b);
      const gap = Math.min(170, Math.max(110, canvasWidth / Math.max(2, ids.length + 1)));
      const start = canvasWidth / 2 - ((ids.length - 1) * gap) / 2;

      ids.forEach((id, idx) => {
        pos.set(id, {
          x: start + idx * gap,
          y: 48 + lv * 86,
          type: 'ocs'
        });
      });
    });
  }

  if (epsNodes.length) {
    const y = 58 + (maxOcsLevel + 1) * 86;
    const gap = Math.min(160, Math.max(110, canvasWidth / Math.max(2, epsNodes.length + 1)));
    const start = canvasWidth / 2 - ((epsNodes.length - 1) * gap) / 2;

    epsNodes.forEach((e, idx) => {
      pos.set(e.id, {
        x: start + idx * gap,
        y,
        type: 'eps'
      });
    });
  }

  const logicalY = 58 + (maxOcsLevel + 1) * 86 + (epsNodes.length ? 86 : 74);
  const totalLogicalWidth = logicalNodes.length * logicalBoxW + Math.max(0, logicalNodes.length - 1) * logicalGap;
  let cursor = canvasWidth / 2 - totalLogicalWidth / 2;
  const logicalBoxes = [];

  logicalNodes.forEach(ln => {
    const endpoints = (ln.endpoints || []).slice().sort((a, b) => {
      return Number(a.rnicGroupId) - Number(b.rnicGroupId) ||
        Number(a.planeId) - Number(b.planeId) ||
        Number(a.carrierNodeId) - Number(b.carrierNodeId);
    });

    const x = cursor + logicalBoxW / 2;
    const box = {
      logicalId: ln.logicalId,
      label: ln.label || `Node ${ln.logicalId}`,
      x,
      y: logicalY,
      width: logicalBoxW,
      height: 76,
      endpoints
    };

    const epGap = endpoints.length > 1 ? Math.min(54, (logicalBoxW - 44) / (endpoints.length - 1)) : 0;
    const epStart = x - ((endpoints.length - 1) * epGap) / 2;

    endpoints.forEach((ep, idx) => {
      const ex = epStart + idx * epGap;
      const ey = logicalY - 20;
      ep._x = ex;
      ep._y = ey;
      pos.set(Number(ep.carrierNodeId), {
        x: ex,
        y: ey,
        type: 'rnic',
        endpointToken: ep.token,
        logicalId: ep.logicalId,
        planeId: ep.planeId,
        rnicGroupId: ep.rnicGroupId,
      });
    });

    logicalBoxes.push(box);
    cursor += logicalBoxW + logicalGap;
  });

  const height = logicalY + 58;

  return {
    pos,
    width: canvasWidth,
    height,
    logicalBoxes,
    logicalEndpointView: true,
  };
}

function layoutHierarchy(topology) {
  if (hasLogicalEndpointView(topology)) {
    return layoutLogicalEndpointTopology(topology);
  }

  const nodes = topology.nodes || [];
  const links = topology.links || [];
  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const adj = buildAdjacency(topology);
  const pos = new Map();

  const typeOf = id => nodeById.get(id)?.type || 'rnic';

  const ocsNodes = nodes
    .filter(n => n.type === 'ocs')
    .slice()
    .sort((a, b) => a.id - b.id);

  const epsNodes = nodes
    .filter(n => n.type === 'eps')
    .slice()
    .sort((a, b) => a.id - b.id);

  const hostNodes = nodes
    .filter(n => n.type !== 'ocs' && n.type !== 'eps')
    .slice()
    .sort((a, b) => a.id - b.id);

  function neighborsOfType(id, type) {
    return (adj.get(id) || []).filter(v => typeOf(v) === type).sort((a, b) => a - b);
  }

  function nonOcsDegree(id) {
    return (adj.get(id) || []).filter(v => typeOf(v) !== 'ocs').length;
  }

  function ocsDegree(id) {
    return (adj.get(id) || []).filter(v => typeOf(v) === 'ocs').length;
  }

  function hostParent(hostId) {
    const eps = neighborsOfType(hostId, 'eps');
    if (eps.length) return eps[0];

    const ocs = neighborsOfType(hostId, 'ocs');
    if (ocs.length) return ocs[0];

    const all = (adj.get(hostId) || []).slice().sort((a, b) => a - b);
    return all.length ? all[0] : null;
  }

  function epsParentOcs(epsId) {
    const ocs = neighborsOfType(epsId, 'ocs');
    if (ocs.length) return ocs[0];
    return null;
  }

  function minConnectedOcsPort(nodeId) {
    const ports = [];

    links.forEach(l => {
      if (l.src === nodeId && typeOf(l.dst) === 'ocs' && l.dst_port !== null && l.dst_port !== undefined) {
        ports.push(Number(l.dst_port));
      }

      if (l.dst === nodeId && typeOf(l.src) === 'ocs' && l.src_port !== null && l.src_port !== undefined) {
        ports.push(Number(l.src_port));
      }
    });

    if (!ports.length) return nodeId;
    return Math.min(...ports);
  }

  const ocsOcsLinks = links.filter(l => typeOf(l.src) === 'ocs' && typeOf(l.dst) === 'ocs');

  /*
   * Case 1: EPS + parallel OCS fabric.
   *
   * Example:
   *   O4 and O5 both connect to EPS0..EPS3.
   *   There is no OCS-OCS link.
   *
   * Layout:
   *   OCS layer
   *   EPS layer
   *   Host layer
   */
  if (ocsNodes.length && epsNodes.length && ocsOcsLinks.length === 0) {
    const hostGap = 48;
    const minBlockWidth = 168;
    const blockGap = 34;
    const leftPad = 42;

    const ocsY = 44;
    const epsY = 132;
    const hostY = 220;

    const epsOrdered = epsNodes
      .slice()
      .sort((a, b) => {
        const pa = minConnectedOcsPort(a.id);
        const pb = minConnectedOcsPort(b.id);
        return pa - pb || a.id - b.id;
      });

    const hostsByEps = new Map();
    epsOrdered.forEach(e => hostsByEps.set(e.id, []));

    hostNodes.forEach(h => {
      const p = hostParent(h.id);
      if (hostsByEps.has(p)) {
        hostsByEps.get(p).push(h.id);
      }
    });

    hostsByEps.forEach(list => list.sort((a, b) => a - b));

    const blocks = epsOrdered.map(e => {
      const children = hostsByEps.get(e.id) || [];
      return {
        epsId: e.id,
        children,
        width: Math.max(minBlockWidth, Math.max(1, children.length) * hostGap + 28)
      };
    });

    const canvasWidth = Math.max(
      520,
      leftPad * 2 +
      blocks.reduce((sum, b) => sum + b.width, 0) +
      Math.max(0, blocks.length - 1) * blockGap
    );

    let cursor = leftPad;
    const epsX = new Map();

    blocks.forEach(block => {
      const centerX = cursor + block.width / 2;
      epsX.set(block.epsId, centerX);

      pos.set(block.epsId, {
        x: centerX,
        y: epsY,
        type: 'eps'
      });

      const startX = centerX - ((block.children.length - 1) * hostGap) / 2;

      block.children.forEach((hid, idx) => {
        pos.set(hid, {
          x: startX + idx * hostGap,
          y: hostY,
          type: 'rnic'
        });
      });

      cursor += block.width + blockGap;
    });

    const fabricLeft = Math.min(...Array.from(epsX.values()));
    const fabricRight = Math.max(...Array.from(epsX.values()));
    const fabricCenter = (fabricLeft + fabricRight) / 2;

    const ocsGap = Math.max(90, Math.min(150, canvasWidth / Math.max(2, ocsNodes.length + 1)));
    const ocsStart = fabricCenter - ((ocsNodes.length - 1) * ocsGap) / 2;

    ocsNodes.forEach((o, idx) => {
      pos.set(o.id, {
        x: ocsStart + idx * ocsGap,
        y: ocsY,
        type: 'ocs'
      });
    });

    return {
      pos,
      width: canvasWidth,
      height: 270
    };
  }

  /*
   * Case 2: OCS fabric has OCS-OCS links.
   *
   * Example:
   *   O5 connects to O3 and O4.
   *   O3 connects to direct RNICs.
   *   O4 connects to EPSs.
   *
   * Layout:
   *   core OCS layer
   *   access OCS layer
   *   EPS/direct-host layer
   *   host-under-EPS layer
   */
  if (ocsNodes.length && ocsOcsLinks.length > 0) {
    const ocsAdj = new Map();
    ocsNodes.forEach(o => ocsAdj.set(o.id, []));

    ocsOcsLinks.forEach(l => {
      ocsAdj.get(l.src).push(l.dst);
      ocsAdj.get(l.dst).push(l.src);
    });

    ocsAdj.forEach(list => list.sort((a, b) => a - b));

    /*
     * Core OCS candidates:
     *   - OCS nodes with no direct EPS/Host attachment.
     *   - If none exists, pick highest OCS-degree node.
     */
    let roots = ocsNodes
      .filter(o => nonOcsDegree(o.id) === 0)
      .map(o => o.id)
      .sort((a, b) => a - b);

    if (!roots.length) {
      let best = ocsNodes[0].id;

      ocsNodes.forEach(o => {
        const d = ocsDegree(o.id);
        const bd = ocsDegree(best);

        if (d > bd || (d === bd && o.id < best)) {
          best = o.id;
        }
      });

      roots = [best];
    }

    const level = new Map();
    const parent = new Map();
    const queue = [];

    roots.forEach(r => {
      level.set(r, 0);
      queue.push(r);
    });

    while (queue.length) {
      const u = queue.shift();

      (ocsAdj.get(u) || []).forEach(v => {
        if (!level.has(v)) {
          level.set(v, level.get(u) + 1);
          parent.set(v, u);
          queue.push(v);
        }
      });
    }

    /*
     * Disconnected OCS fallback.
     */
    ocsNodes.forEach(o => {
      if (!level.has(o.id)) {
        level.set(o.id, 0);
        roots.push(o.id);
      }
    });

    const ocsChildren = new Map();
    ocsNodes.forEach(o => ocsChildren.set(o.id, []));

    parent.forEach((p, child) => {
      if (ocsChildren.has(p)) {
        ocsChildren.get(p).push(child);
      }
    });

    ocsChildren.forEach(list => list.sort((a, b) => a - b));

    const hostsByEps = new Map();
    epsNodes.forEach(e => hostsByEps.set(e.id, []));

    hostNodes.forEach(h => {
      const p = hostParent(h.id);
      if (hostsByEps.has(p)) {
        hostsByEps.get(p).push(h.id);
      }
    });

    hostsByEps.forEach(list => list.sort((a, b) => a - b));

    const epsByOcs = new Map();
    const directHostsByOcs = new Map();

    ocsNodes.forEach(o => {
      epsByOcs.set(o.id, []);
      directHostsByOcs.set(o.id, []);
    });

    epsNodes.forEach(e => {
      const p = epsParentOcs(e.id);
      if (p !== null && epsByOcs.has(p)) {
        epsByOcs.get(p).push(e.id);
      }
    });

    hostNodes.forEach(h => {
      const p = hostParent(h.id);

      /*
       * If host is under EPS, do not also place it under OCS.
       */
      if (typeOf(p) === 'eps') {
        return;
      }

      if (p !== null && directHostsByOcs.has(p)) {
        directHostsByOcs.get(p).push(h.id);
      }
    });

    epsByOcs.forEach(list => list.sort((a, b) => {
      const pa = minConnectedOcsPort(a);
      const pb = minConnectedOcsPort(b);
      return pa - pb || a - b;
    }));

    directHostsByOcs.forEach(list => list.sort((a, b) => a - b));

    const hostGap = 48;
    const epsGap = 130;
    const blockGap = 60;
    const leftPad = 44;
    const minBlockWidth = 168;

    function localBlockWidth(ocsId) {
      const directHosts = directHostsByOcs.get(ocsId) || [];
      const epsList = epsByOcs.get(ocsId) || [];

      let width = 0;

      if (directHosts.length) {
        width += Math.max(minBlockWidth, directHosts.length * hostGap + 28);
      }

      if (epsList.length) {
        const epsWidths = epsList.map(eid => {
          const hs = hostsByEps.get(eid) || [];
          return Math.max(120, Math.max(1, hs.length) * hostGap + 24);
        });

        width += epsWidths.reduce((a, b) => a + b, 0);
        width += Math.max(0, epsWidths.length - 1) * 24;
      }

      if (directHosts.length && epsList.length) {
        width += 40;
      }

      return Math.max(minBlockWidth, width);
    }

    /*
     * Anchor OCS:
     *   - OCS with direct EPS/Host attachment.
     *   - OCS with no OCS children.
     *
     * These determine horizontal blocks.
     */
    const anchorOcs = ocsNodes
      .filter(o => {
        const hasLocal = nonOcsDegree(o.id) > 0;
        const hasChild = (ocsChildren.get(o.id) || []).length > 0;
        return hasLocal || !hasChild;
      })
      .sort((a, b) => {
        const la = level.get(a.id) ?? 0;
        const lb = level.get(b.id) ?? 0;
        return la - lb || a.id - b.id;
      });

    const anchorInfo = anchorOcs.map(o => ({
      id: o.id,
      width: localBlockWidth(o.id)
    }));

    const canvasWidth = Math.max(
      520,
      leftPad * 2 +
      anchorInfo.reduce((sum, a) => sum + a.width, 0) +
      Math.max(0, anchorInfo.length - 1) * blockGap
    );

    let cursor = leftPad;

    anchorInfo.forEach(a => {
      const x = cursor + a.width / 2;

      pos.set(a.id, {
        x,
        y: 48 + (level.get(a.id) || 0) * 84,
        type: 'ocs'
      });

      cursor += a.width + blockGap;
    });

    /*
     * Place non-anchor OCS by averaging child x.
     * This places core OCS above access OCSs.
     */
    const ocsIdsByDescendingLevel = ocsNodes
      .map(o => o.id)
      .sort((a, b) => {
        const la = level.get(a) ?? 0;
        const lb = level.get(b) ?? 0;
        return lb - la || a - b;
      });

    ocsIdsByDescendingLevel.forEach(id => {
      if (pos.has(id)) return;

      const children = ocsChildren.get(id) || [];
      const childXs = children
        .map(c => pos.get(c))
        .filter(Boolean)
        .map(p => p.x);

      let x;

      if (childXs.length) {
        x = childXs.reduce((a, b) => a + b, 0) / childXs.length;
      } else {
        x = canvasWidth / 2;
      }

      pos.set(id, {
        x,
        y: 48 + (level.get(id) || 0) * 84,
        type: 'ocs'
      });
    });

    /*
     * If parent was computed after children, some parents may still need centering.
     */
    const ocsIdsByAscendingLevel = ocsNodes
      .map(o => o.id)
      .sort((a, b) => {
        const la = level.get(a) ?? 0;
        const lb = level.get(b) ?? 0;
        return la - lb || a - b;
      });

    ocsIdsByAscendingLevel.forEach(id => {
      const children = ocsChildren.get(id) || [];
      const childXs = children
        .map(c => pos.get(c))
        .filter(Boolean)
        .map(p => p.x);

      if (childXs.length) {
        const p = pos.get(id);
        p.x = childXs.reduce((a, b) => a + b, 0) / childXs.length;
      }
    });

    /*
     * Place local EPS and direct hosts under each access OCS.
     */
    let maxY = 0;

    ocsNodes.forEach(o => {
      const oid = o.id;
      const oPos = pos.get(oid);
      if (!oPos) return;

      maxY = Math.max(maxY, oPos.y);

      const directHosts = directHostsByOcs.get(oid) || [];
      const epsList = epsByOcs.get(oid) || [];

      const localY = oPos.y + 84;
      const hostUnderEpsY = localY + 72;

      let localItems = [];

      if (directHosts.length) {
        const w = Math.max(minBlockWidth, directHosts.length * hostGap + 28);
        localItems.push({
          kind: 'directHosts',
          ids: directHosts,
          width: w
        });
      }

      epsList.forEach(eid => {
        const hs = hostsByEps.get(eid) || [];
        const w = Math.max(120, Math.max(1, hs.length) * hostGap + 24);
        localItems.push({
          kind: 'eps',
          id: eid,
          hosts: hs,
          width: w
        });
      });

      if (!localItems.length) return;

      const totalW = localItems.reduce((sum, item) => sum + item.width, 0) +
        Math.max(0, localItems.length - 1) * 24;

      let localCursor = oPos.x - totalW / 2;

      localItems.forEach(item => {
        const centerX = localCursor + item.width / 2;

        if (item.kind === 'directHosts') {
          const ids = item.ids;
          const startX = centerX - ((ids.length - 1) * hostGap) / 2;

          ids.forEach((hid, idx) => {
            pos.set(hid, {
              x: startX + idx * hostGap,
              y: localY,
              type: 'rnic'
            });
          });

          maxY = Math.max(maxY, localY);
        }

        if (item.kind === 'eps') {
          pos.set(item.id, {
            x: centerX,
            y: localY,
            type: 'eps'
          });

          const hs = item.hosts || [];
          const startX = centerX - ((hs.length - 1) * hostGap) / 2;

          hs.forEach((hid, idx) => {
            pos.set(hid, {
              x: startX + idx * hostGap,
              y: hostUnderEpsY,
              type: 'rnic'
            });
          });

          maxY = Math.max(maxY, hostUnderEpsY);
        }

        localCursor += item.width + 24;
      });
    });

    /*
     * Fallback for any unplaced EPS / hosts.
     */
    const unplaced = nodes
      .filter(n => !pos.has(n.id))
      .sort((a, b) => a.id - b.id);

    if (unplaced.length) {
      const y = maxY + 74;
      const gap = 54;
      const startX = canvasWidth / 2 - ((unplaced.length - 1) * gap) / 2;

      unplaced.forEach((n, idx) => {
        pos.set(n.id, {
          x: startX + idx * gap,
          y,
          type: n.type || 'rnic'
        });
      });

      maxY = y;
    }

    return {
      pos,
      width: canvasWidth,
      height: maxY + 48
    };
  }

  /*
   * Case 3: EPS-only topology.
   */
  if (epsNodes.length && !ocsNodes.length) {
    const hostGap = 50;
    const minBlockWidth = 168;
    const blockGap = 34;
    const leftPad = 42;
    const epsY = 54;
    const hostY = 144;

    const hostsByEps = new Map();
    epsNodes.forEach(e => hostsByEps.set(e.id, []));

    hostNodes.forEach(h => {
      const p = hostParent(h.id);
      if (hostsByEps.has(p)) {
        hostsByEps.get(p).push(h.id);
      }
    });

    hostsByEps.forEach(list => list.sort((a, b) => a - b));

    const blocks = epsNodes.map(e => {
      const children = hostsByEps.get(e.id) || [];

      return {
        epsId: e.id,
        children,
        width: Math.max(minBlockWidth, Math.max(1, children.length) * hostGap + 28)
      };
    });

    const canvasWidth = Math.max(
      460,
      leftPad * 2 +
      blocks.reduce((s, b) => s + b.width, 0) +
      Math.max(0, blocks.length - 1) * blockGap
    );

    let cursor = leftPad;

    blocks.forEach(block => {
      const centerX = cursor + block.width / 2;

      pos.set(block.epsId, {
        x: centerX,
        y: epsY,
        type: 'eps'
      });

      const startX = centerX - ((block.children.length - 1) * hostGap) / 2;

      block.children.forEach((hid, idx) => {
        pos.set(hid, {
          x: startX + idx * hostGap,
          y: hostY,
          type: 'rnic'
        });
      });

      cursor += block.width + blockGap;
    });

    return {
      pos,
      width: canvasWidth,
      height: 190
    };
  }

  /*
   * Case 4: fallback flat layout.
   */
  const gap = 64;
  const width = Math.max(420, nodes.length * gap + 80);
  const y = 70;

  nodes
    .slice()
    .sort((a, b) => a.id - b.id)
    .forEach((n, idx) => {
      pos.set(n.id, {
        x: 40 + idx * gap,
        y,
        type: n.type || 'rnic'
      });
    });

  return {
    pos,
    width,
    height: 140
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
    return `<line class="link-active-colored" style="stroke:${color}" x1="${peerPos.x}" y1="${peerPos.y}" x2="${center.x}" y2="${center.y}" />`;
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

    return `<line class="link-physical" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" />`;
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
          <g class="node-group node-group-ocs">
            <title>OCS ${n.id}</title>
            <rect class="node-ocs" x="${p.x - 20}" y="${p.y - 20}" width="40" height="40" rx="7" transform="rotate(45 ${p.x} ${p.y})"/>
            <text class="node-label node-label-ocs" x="${p.x}" y="${p.y}">O${n.id}</text>
          </g>
        `;
      }

      if (n.type === 'eps') {
        return `
          <g class="node-group node-group-eps">
            <title>EPS ${n.id}</title>
            <rect class="node-eps" x="${p.x - 28}" y="${p.y - 16}" width="56" height="32" rx="9"/>
            <text class="node-label node-label-eps" x="${p.x}" y="${p.y}">E${n.id}</text>
          </g>
        `;
      }

      return `
        <g class="node-group node-group-host">
          <circle class="node-rnic" cx="${p.x}" cy="${p.y}" r="18"/>
          <text class="node-label node-label-host" x="${p.x}" y="${p.y}">H${n.id}</text>
        </g>
      `;
    }).join('');

  const logicalNodeEls = logicalBoxes.map(box => {
    const endpointEls = (box.endpoints || []).map(ep => {
      const p = pos.get(Number(ep.carrierNodeId));
      if (!p) return '';
      const label = ep.label || `P${ep.planeId}`;
      const title = `Endpoint ${ep.token}\nLogical node: ${ep.logicalId}\nRNIC group: ${ep.rnicGroupId}\nPlane: ${ep.planeId}\nCarrier RNIC: ${ep.carrierNodeId}`;
      return `
        <g class="logical-endpoint-port">
          <title>${escapeHtml(title)}</title>
          <circle class="endpoint-port-dot" cx="${p.x}" cy="${p.y}" r="7"/>
          <text class="endpoint-port-label" x="${p.x}" y="${p.y + 20}">${escapeHtml(label)}</text>
          <text class="endpoint-token-label" x="${p.x}" y="${p.y + 34}">${escapeHtml(ep.token)}</text>
        </g>
      `;
    }).join('');

    return `
      <g class="logical-node-group">
        <title>${escapeHtml(box.label)}</title>
        <rect class="logical-node-card" x="${box.x - box.width / 2}" y="${box.y - box.height / 2}" width="${box.width}" height="${box.height}" rx="12"/>
        <text class="logical-node-title" x="${box.x}" y="${box.y + 22}">${escapeHtml(box.label)}</text>
        ${endpointEls}
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
        return `<text class="port-annotation" style="fill:${color}" x="${p.x}" y="${p.y - 28 - idx * 11}">${c.a}↔${c.b}</text>`;
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

  return `
    <div class="slice-panel interval-panel">
      <div class="slice-title">
        <span>${title}</span>
        <span>${timeLabel}</span>
      </div>
      <div class="mapping-legend">${mappingLegend}</div>
      <svg class="topology-svg" viewBox="0 0 ${width} ${height}" role="img">
        ${physical}
        ${activeExternalLines}
        ${nodeEls}
        ${portAnnotations}
      </svg>
      <div class="topology-node-legend">
        <span><span class="legend-shape legend-host"></span>${logicalEndpointView ? 'Logical node / endpoint' : 'RNIC'}</span>
        <span><span class="legend-shape legend-eps"></span>EPS</span>
        <span><span class="legend-shape legend-ocs"></span>OCS</span>
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