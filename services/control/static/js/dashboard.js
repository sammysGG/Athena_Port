(() => {
  const CSRF = document.querySelector('meta[name="csrf-token"]')?.content || '';

  const $ = (id) => document.getElementById(id);
  const fmtTime = (s) => new Date(s * 1000).toLocaleTimeString();
  const text = (el, v) => { if (el && el.textContent !== String(v)) el.textContent = v; };

  let lastSnapshot = null;

  function renderBerths(snap) {
    const root = $('berths');
    if (!root) return;
    const cranesByBerth = new Map();
    for (const c of snap.cranes) {
      if (!cranesByBerth.has(c.berth_id)) cranesByBerth.set(c.berth_id, []);
      cranesByBerth.get(c.berth_id).push(c);
    }
    const ships = new Map(snap.ships.map((s) => [s.id, s]));
    root.innerHTML = '';
    for (const b of snap.berths) {
      const row = document.createElement('div');
      const shipHere = b.ship_id ? ships.get(b.ship_id) : null;
      const damagedHere = shipHere && shipHere.damaged;
      row.className = `berth ${b.status}${damagedHere ? ' has-overload' : ''}`;
      const id = document.createElement('div');
      id.className = 'berth-id';
      if (b.status === 'closed') {
        id.innerHTML = `<span class="redx">✕</span> B${b.id}`;
      } else {
        id.textContent = `B${b.id}`;
      }
      const info = document.createElement('div');
      info.className = 'berth-info';
      const top = document.createElement('div');
      if (b.ship_id) {
        const ship = shipHere;
        const ovr = ship && ship.damaged
          ? ` <span class="overload-badge${ship.condemned ? ' is-condemned' : ''}">⚠ OVERLOAD ${ship.damage}</span>`
          : '';
        top.innerHTML = ship
          ? `<span class="ship">${escapeHtml(ship.name)}</span> <span class="muted small">${ship.status}</span>${ovr}`
          : `<span class="ship">${escapeHtml(b.ship_id)}</span>`;
      } else if (b.status === 'closed') {
        top.innerHTML = '<span class="empty redx-line">✕ closed (maintenance)</span>';
      } else {
        top.innerHTML = '<span class="empty">— open · awaiting ship —</span>';
      }
      info.appendChild(top);
      const cranes = document.createElement('div');
      cranes.className = 'cranes';
      const myCranes = cranesByBerth.get(b.id) || [];
      for (const c of myCranes) {
        const chip = document.createElement('span');
        chip.className = `crane ${c.status}`;
        chip.title = c.last_action || '';
        const tail = c.status === 'maintenance' ? ` ${c.remaining_maint}t` : '';
        chip.textContent = `${c.id} ${c.status}${tail}`;
        cranes.appendChild(chip);
      }
      info.appendChild(cranes);
      row.appendChild(id);
      row.appendChild(info);
      root.appendChild(row);
    }
  }

  function renderShips(snap) {
    const body = $('ships-body');
    if (!body) return;
    body.innerHTML = '';
    for (const s of snap.ships) {
      const tr = document.createElement('tr');
      tr.title = `${s.name} — click for detail view`;
      tr.dataset.shipId = s.id;
      const dl = s.ticks_to_deadline;
      const dlClass = dl < 0 ? 'bad' : dl < 60 ? 'warn' : '';
      // Damage state — drives row tint + OVERLOAD badge next to the name
      let rowCls = '';
      if (s.condemned) rowCls = 'ship-condemned';
      else if (s.damaged) rowCls = 'ship-damaged';
      tr.className = rowCls;
      const badge = s.damaged
        ? ` <span class="overload-badge${s.condemned ? ' is-condemned' : ''}" title="overload ${s.overload}, damage ${s.damage}">⚠ OVERLOAD ${s.damage}</span>`
        : '';
      const expCell = s.load_count > s.capacity
        ? `<td class="bad" title="loaded ${s.load_count} on a ${s.capacity}-rated ship">${s.exports_remaining}/${s.total_exports}</td>`
        : `<td>${s.exports_remaining}/${s.total_exports}</td>`;
      tr.innerHTML =
        `<td>${escapeHtml(s.id)}</td>` +
        `<td title="${escapeHtml(s.name)}">${escapeHtml(s.name)}${badge}</td>` +
        `<td>${escapeHtml(s.status)}</td>` +
        `<td>${s.berth_id ? 'B' + s.berth_id : '—'}</td>` +
        `<td>${s.imports_remaining}/${s.total_imports}</td>` +
        expCell +
        `<td class="${dlClass}">${dl}t</td>`;
      tr.addEventListener('click', () => {
        selectedShipId = s.id;
        setView('ship');
      });
      body.appendChild(tr);
    }
    text($('queue-len'), snap.queue_length);
  }

  // Rolling memory of the score for delta-per-minute display in the hero.
  const heroDeltaWindow = [];   // {ts, total}
  function pushDelta(total) {
    const now = Date.now();
    heroDeltaWindow.push({ ts: now, total });
    // keep the last 90s
    while (heroDeltaWindow.length && now - heroDeltaWindow[0].ts > 90_000) {
      heroDeltaWindow.shift();
    }
  }
  function ratePerMin() {
    if (heroDeltaWindow.length < 2) return 0;
    const a = heroDeltaWindow[0], b = heroDeltaWindow[heroDeltaWindow.length - 1];
    const dt = (b.ts - a.ts) / 1000;
    if (dt < 5) return 0;
    return Math.round(((b.total - a.total) / dt) * 60);
  }

  function renderHero(snap) {
    const s = snap.score;
    const total = s.imports + s.exports;
    pushDelta(total);

    text($('hero-total'), total.toLocaleString());
    text($('hero-imp'), s.imports.toLocaleString());
    text($('hero-exp'), s.exports.toLocaleString());

    const docked = snap.ships.filter((sh) => sh.status === 'docking' || sh.status === 'working' || sh.status === 'departing').length;
    const queued = snap.queue_length;
    text($('hero-ships'), (docked + queued).toLocaleString());
    text($('hero-ships-sub'), `${docked} docked, ${queued} queued`);

    text($('hero-imp-sub'), `${snap.yard.imports_staged} staged, ${s.missed_imports} missed`);
    text($('hero-exp-sub'), `${snap.yard.exports_staged} staged, ${s.missed_exports} missed`);

    const rate = ratePerMin();
    const deltaEl = $('hero-delta');
    if (deltaEl) {
      deltaEl.textContent = `${rate >= 0 ? '+' : ''}${rate}/min`;
      deltaEl.style.color = rate > 0 ? 'var(--accent-2)' : rate < 0 ? 'var(--bad)' : 'var(--fg-dim)';
    }

    // uptime → mm:ss / hh:mm:ss
    const sec = snap.uptime_seconds || 0;
    const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
    const fmt = hh > 0
      ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
      : `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
    text($('hero-uptime'), fmt);
    text($('hero-tick'), `t${snap.tick.toLocaleString()} (${snap.throughput.moves_per_min}/min sim)`);

    renderHeroSpark(snap);
  }

  function renderHeroSpark(snap) {
    const root = $('hero-spark');
    if (!root) return;
    const data = snap.score_history || [];
    while (root.firstChild) root.removeChild(root.firstChild);
    if (data.length < 2) return;
    const w = 400, h = 50;
    const moves = data.map((d) => d.moves);
    const maxV = Math.max(2, ...moves);
    let line = '', area = '';
    for (let i = 0; i < moves.length; i++) {
      const x = (i / (moves.length - 1)) * w;
      const y = h - (moves[i] / maxV) * (h - 6) - 3;
      line += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)} `;
    }
    area = `M0,${h} L` + line.slice(1) + ` L${w},${h} Z`;
    // gradient fill
    const ns = 'http://www.w3.org/2000/svg';
    const defs = document.createElementNS(ns, 'defs');
    const grad = document.createElementNS(ns, 'linearGradient');
    grad.setAttribute('id', 'spark-grad');
    grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0');
    grad.setAttribute('x2', '0'); grad.setAttribute('y2', '1');
    const s1 = document.createElementNS(ns, 'stop');
    s1.setAttribute('offset', '0%'); s1.setAttribute('stop-color', '#0072CE'); s1.setAttribute('stop-opacity', '0.45');
    const s2 = document.createElementNS(ns, 'stop');
    s2.setAttribute('offset', '100%'); s2.setAttribute('stop-color', '#0072CE'); s2.setAttribute('stop-opacity', '0');
    grad.appendChild(s1); grad.appendChild(s2);
    defs.appendChild(grad);
    root.appendChild(defs);
    const fill = document.createElementNS(ns, 'path');
    fill.setAttribute('d', area);
    fill.setAttribute('fill', 'url(#spark-grad)');
    root.appendChild(fill);
    const stroke = document.createElementNS(ns, 'path');
    stroke.setAttribute('d', line);
    stroke.setAttribute('fill', 'none');
    stroke.setAttribute('stroke', '#0072CE');
    stroke.setAttribute('stroke-width', '1.6');
    stroke.setAttribute('vector-effect', 'non-scaling-stroke');
    root.appendChild(stroke);
  }

  function renderAlarms(snap) {
    // Rail (read-only) and drawer (with ack buttons) get parallel lists.
    const railRoot = $('alarms');
    const drawerRoot = $('drawer-alarms');
    for (const root of [railRoot, drawerRoot]) {
      if (!root) continue;
      root.innerHTML = '';
      if (!snap.alarms.length) {
        const li = document.createElement('li');
        li.className = 'empty';
        li.textContent = '— no active alarms —';
        root.appendChild(li);
        continue;
      }
      for (const a of snap.alarms) {
        const li = document.createElement('li');
        const level = (a.level || 'warn').toLowerCase();
        li.className = `alarm-${level}`;
        if (level === 'alarm') li.classList.add('is-loud');
        const txt = document.createElement('span');
        // High-severity alarms get a leading red X marker so blocked /
        // unknown-error states are unmistakeable at a glance.
        const marker = level === 'alarm'
          ? '✕ '
          : level === 'warn' ? '⚠ ' : '';
        txt.textContent = marker + a.text;
        li.appendChild(txt);
        if (root === drawerRoot) {
          const btn = document.createElement('button');
          btn.textContent = 'ack';
          btn.addEventListener('click', () => sendCommand('ack-alarm', { key: a.key }));
          li.appendChild(btn);
        }
        root.appendChild(li);
      }
    }
  }

  // Track which events we've already shown so the ticker grows in place
  // instead of being rebuilt each tick (rebuild would reset the CSS scroll).
  let lastTickerSeq = -1;

  function renderEvents(snap) {
    const events = snap.events || [];

    // Drawer events: rebuild each time (it's hidden mostly anyway).
    const drawer = $('drawer-events');
    if (drawer) {
      drawer.innerHTML = '';
      for (const e of events.slice().reverse()) {
        const li = document.createElement('li');
        li.className = e.level;
        const t = document.createElement('span');
        t.className = 't';
        t.textContent = `${fmtTime(e.ts)} t${e.tick}`;
        const txt = document.createElement('span');
        txt.textContent = e.text;
        li.appendChild(t);
        li.appendChild(txt);
        drawer.appendChild(li);
      }
    }

    // Ticker: render the last 30 events. We rebuild and duplicate the track
    // so the CSS marquee can loop seamlessly via translateX(-50%).
    const track = $('ticker-track');
    if (!track || !events.length) return;
    const recent = events.slice(-30);
    const last = recent[recent.length - 1];
    const seq = `${last.tick}:${last.ts}`;
    if (seq === lastTickerSeq) return;
    lastTickerSeq = seq;

    const fragment = document.createDocumentFragment();
    const buildOne = (e) => {
      const span = document.createElement('span');
      span.className = `ticker-item ${e.level}`;
      const pip = document.createElement('span');
      pip.className = 'pip';
      const ts = document.createElement('span');
      ts.className = 'ts';
      ts.textContent = `${fmtTime(e.ts)} t${e.tick}`;
      const txt = document.createElement('span');
      txt.textContent = e.text;
      span.appendChild(pip);
      span.appendChild(ts);
      span.appendChild(txt);
      return span;
    };
    const sep = () => {
      const s = document.createElement('span');
      s.className = 'sep';
      s.textContent = '·';
      return s;
    };
    // Render twice so the marquee can wrap by translating -50%
    for (let pass = 0; pass < 2; pass++) {
      for (const e of recent) {
        fragment.appendChild(buildOne(e));
        fragment.appendChild(sep());
      }
    }
    track.innerHTML = '';
    track.appendChild(fragment);
  }

  function renderCommandOptions(snap) {
    fillSelect($('cmd-crane'), snap.cranes.map((c) => ({ value: c.id, label: `${c.id} (@B${c.berth_id} · ${c.status})` })));
    fillSelect($('cmd-crane-berth'), snap.berths.map((b) => ({ value: b.id, label: `B${b.id} (${b.status})` })));
    fillSelect($('cmd-berth'), snap.berths.map((b) => ({ value: b.id, label: `B${b.id} (${b.status})` })));
    const docking = snap.ships.filter((s) => s.status === 'docking');
    fillSelect($('cmd-ship'), docking.length
      ? docking.map((s) => ({ value: s.id, label: `${s.id} ${s.name}` }))
      : [{ value: '', label: '— no ship docking —' }]);
  }

  function fillSelect(sel, options) {
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '';
    for (const opt of options) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      sel.appendChild(o);
    }
    if (options.some((o) => String(o.value) === prev)) sel.value = prev;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  async function sendCommand(name, payload) {
    const res = $('cmd-result');
    try {
      const resp = await fetch(`/api/command/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': CSRF },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      });
      if (resp.status === 401) { window.location = '/login'; return; }
      const data = await resp.json();
      if (data.ok) {
        res.className = 'cmd-result ok';
        res.textContent = `✓ ${name} ${JSON.stringify(payload)}`;
      } else {
        res.className = 'cmd-result err';
        res.textContent = `✗ ${name}: ${data.error || resp.statusText}`;
      }
    } catch (e) {
      res.className = 'cmd-result err';
      res.textContent = `✗ ${name}: ${e}`;
    }
  }

  function bindCommands() {
    document.querySelectorAll('[data-cmd]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const cmd = btn.dataset.cmd;
        if (cmd === 'reassign') {
          sendCommand('reassign-crane', {
            crane_id: $('cmd-crane').value,
            berth_id: Number($('cmd-crane-berth').value),
          });
        } else if (cmd === 'berth') {
          sendCommand('berth-status', {
            berth_id: Number($('cmd-berth').value),
            status: $('cmd-berth-status').value,
          });
        } else if (cmd === 'expedite') {
          const v = $('cmd-ship').value;
          if (!v) return;
          sendCommand('expedite', { ship_id: v });
        }
      });
    });
  }

  function clockTick() {
    const el = $('clock');
    if (el) el.textContent = new Date().toLocaleTimeString();
  }

  /* ── connection status pill ──────────────────────────────────────── */
  let lastSnapshotAt = 0;
  function setStatus(state) {
    const pill = $('status-pill');
    if (!pill) return;
    pill.classList.remove('is-live', 'is-stale');
    const t = pill.querySelector('.t');
    if (state === 'live')  { pill.classList.add('is-live');  if (t) t.textContent = 'live';   lastSnapshotAt = Date.now(); }
    if (state === 'stale') { pill.classList.add('is-stale'); if (t) t.textContent = 'stale'; }
    if (state === 'down')  { pill.classList.add('is-stale'); if (t) t.textContent = 'reconnecting…'; }
  }
  // Watchdog: if no snapshot for >6s, mark stale.
  setInterval(() => {
    if (lastSnapshotAt && Date.now() - lastSnapshotAt > 6000) setStatus('stale');
  }, 2000);

  /* ── console drawer toggle ───────────────────────────────────────── */
  function openDrawer() {
    const d = $('console-drawer'), b = $('drawer-backdrop');
    if (!d || !b) return;
    d.hidden = false; b.hidden = false;
    d.setAttribute('aria-hidden', 'false');
    // ensure command options are fresh
    if (lastSnapshot) renderCommandOptions(lastSnapshot);
  }
  function closeDrawer() {
    const d = $('console-drawer'), b = $('drawer-backdrop');
    if (!d || !b) return;
    d.hidden = true; b.hidden = true;
    d.setAttribute('aria-hidden', 'true');
  }
  function bindDrawer() {
    $('console-toggle')?.addEventListener('click', openDrawer);
    $('console-close')?.addEventListener('click', closeDrawer);
    $('drawer-backdrop')?.addEventListener('click', closeDrawer);
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') closeDrawer();
    });
  }

  function applySnapshot(snap) {
    lastSnapshot = snap;
    renderHero(snap);
    renderBerths(snap);
    renderShips(snap);
    renderAlarms(snap);
    renderEvents(snap);
    renderCommandOptions(snap);
    renderView(snap);
    setStatus('live');
  }

  /* ── view registry ───────────────────────────────────────────────── */
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MAP_H = 900;
  let   MAP_W = 1600;   // recomputed each render to match container aspect

  // Resize the map's viewBox to match the container's actual aspect ratio,
  // so content fills the wrapper instead of letterboxing inside a 4:3 box.
  function updateMapDimensions() {
    const svg = $('port-map');
    if (!svg) return;
    const cw = svg.clientWidth  || svg.parentElement?.clientWidth  || 1200;
    const ch = svg.clientHeight || svg.parentElement?.clientHeight || 900;
    if (cw > 0 && ch > 0) {
      MAP_W = Math.round((cw / ch) * MAP_H);
    }
    svg.setAttribute('viewBox', `0 0 ${MAP_W} ${MAP_H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
  }

  // Container-type colors used in ship hulls, yard stacks, ship-detail bars.
  const TYPE_COLORS = {
    '20ft':   { fill: '#fde68a', stroke: '#d97706' },  // amber
    '40ft':   { fill: '#bfdbfe', stroke: '#0072CE' },  // blue
    '40HC':   { fill: '#a7f3d0', stroke: '#059669' },  // emerald
    'reefer': { fill: '#a5f3fc', stroke: '#0891b2' },  // cyan
    'tank':   { fill: '#fef3c7', stroke: '#a16207' },  // yellow
  };
  const TYPE_ORDER = ['20ft', '40ft', '40HC', 'reefer', 'tank'];

  const VIEWS = {
    overview:   { render: renderOverview,   buildToolbar: null,             legend: legendOverview },
    ship:       { render: renderShipDetail, buildToolbar: buildShipToolbar, legend: legendShipDetail },
    yard:       { render: renderYardDetail, buildToolbar: null,             legend: legendYard },
    throughput: { render: renderThroughput, buildToolbar: null,             legend: legendThroughput },
  };
  let activeView = 'overview';
  let selectedShipId = null;
  // Vertical bands (taller layout so panel fills its 4:3-ish slot):
  //   0..170   anchorage (queued ships)
  //   170..200 sea/quay edge waterline
  //   200..480 quay: berths + ships + cranes
  //   480..760 yard (import + export stacks)
  //   760..900 gate (two-lane road: top lane right→exit, bottom lane left→entry)
  function svgEl(name, attrs, parent) {
    const e = document.createElementNS(SVG_NS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function svgText(parent, x, y, text, attrs) {
    const t = svgEl('text', Object.assign({ x, y, 'font-size': 12, fill: '#64748b', 'font-family': 'inherit' }, attrs || {}), parent);
    t.textContent = text;
    return t;
  }

  function clearSvg(root) {
    while (root.firstChild) root.removeChild(root.firstChild);
  }

  function renderOverview(snap) {
    const root = $('port-map');
    if (!root) return;
    clearSvg(root);

    // gradients
    const defs = svgEl('defs', {}, root);
    const grad = svgEl('linearGradient', { id: 'sea-grad', x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    svgEl('stop', { offset: '0%', 'stop-color': '#e0f2fe' }, grad);
    svgEl('stop', { offset: '100%', 'stop-color': '#bae6fd' }, grad);

    // ── water ──────────────────────────────────────────────────────────
    svgEl('rect', { x: 0, y: 0, width: MAP_W, height: 200, fill: 'url(#sea-grad)' }, root);
    // ripples
    for (let i = 0; i < 6; i++) {
      const y = 30 + i * 25;
      svgEl('path', {
        d: `M0,${y} Q${MAP_W * 0.25},${y - 4} ${MAP_W * 0.5},${y} T${MAP_W},${y}`,
        fill: 'none', stroke: '#7dd3fc', 'stroke-width': 0.8, opacity: 0.7,
      }, root);
    }

    // quay base + apron
    svgEl('rect', { x: 0, y: 200, width: MAP_W, height: 18, fill: '#94a3b8' }, root);
    svgEl('rect', { x: 0, y: 218, width: MAP_W, height: 262, fill: '#e2e8f0' }, root);
    // bollards along quay edge
    for (let i = 80; i < MAP_W - 40; i += 90) {
      svgEl('circle', { cx: i, cy: 209, r: 2.5, fill: '#475569' }, root);
    }

    // yard base
    svgEl('rect', { x: 0, y: 480, width: MAP_W, height: 280, fill: '#f1f5f9' }, root);
    // gate strip (two lanes)
    svgEl('rect', { x: 0, y: 760, width: MAP_W, height: 140, fill: '#e5e7eb' }, root);
    svgEl('line', { x1: 0, y1: 830, x2: MAP_W, y2: 830, stroke: '#cbd5e1', 'stroke-width': 1, 'stroke-dasharray': '20 14' }, root);

    // section labels
    svgText(root, 12, 22, 'Anchorage', { fill: '#64748b', 'font-size': 13 });
    svgText(root, 12, 236, 'Quay & berths', { fill: '#64748b', 'font-size': 13 });
    svgText(root, 12, 500, 'Yard', { fill: '#64748b', 'font-size': 13 });
    svgText(root, 12, 778, 'Gate', { fill: '#64748b', 'font-size': 13 });

    // ── anchorage: queued ships ────────────────────────────────────────
    const queued = snap.ships.filter((s) => s.status === 'queued' || (s.berth_id === null && s.status !== 'departed'));
    queued.slice(0, 8).forEach((s, i) => {
      const x = 140 + i * 130;
      const y = 80;
      drawShipIcon(root, x, y, 90, 30, '#bfdbfe', '#004F99');
      svgText(root, x + 45, y - 8, s.name, { 'text-anchor': 'middle', fill: '#1e40af', 'font-size': 11 });
      svgText(root, x + 45, y + 46, `${s.total_imports}i / ${s.total_exports}e`, { 'text-anchor': 'middle', fill: '#94a3b8', 'font-size': 10 });
    });
    if (queued.length > 8) {
      svgText(root, MAP_W - 16, 80, `+${queued.length - 8} more`, { 'text-anchor': 'end', fill: '#1e40af' });
    }

    // ── berths along the quay ──────────────────────────────────────────
    const n = snap.berths.length;
    const berthW = Math.min(280, (MAP_W - 80) / n);
    const startX = (MAP_W - berthW * n) / 2;

    const cranesByBerth = new Map();
    for (const c of snap.cranes) {
      if (!cranesByBerth.has(c.berth_id)) cranesByBerth.set(c.berth_id, []);
      cranesByBerth.get(c.berth_id).push(c);
    }

    snap.berths.forEach((b, idx) => {
      const x = startX + idx * berthW;
      const closed = b.status === 'closed';
      // berth slot frame on quay edge — red dashed + X overlay when closed
      svgEl('rect', {
        x: x + 6, y: 222, width: berthW - 12, height: 16,
        fill: closed ? '#fee2e2' : 'none',
        stroke: closed ? '#dc2626' : '#059669',
        'stroke-dasharray': closed ? '4 3' : '0', 'stroke-width': closed ? 2 : 1,
      }, root);
      if (closed) {
        // Big red X across the berth slot — unmistakeable "blocked" marker
        const x1 = x + 8, x2 = x + berthW - 8, y1 = 224, y2 = 236;
        svgEl('line', { x1, y1, x2, y2, stroke: '#dc2626', 'stroke-width': 2.5 }, root);
        svgEl('line', { x1, y1: y2, x2, y2: y1, stroke: '#dc2626', 'stroke-width': 2.5 }, root);
      }
      svgText(root, x + berthW / 2, 260,
        `Berth ${b.id}${closed ? ' · ✕ CLOSED' : ''}`,
        { 'text-anchor': 'middle', fill: closed ? '#dc2626' : '#0072CE', 'font-size': 11, 'font-weight': closed ? '700' : '400' });

      // ship at berth
      let ship = null;
      if (b.ship_id) ship = snap.ships.find((s) => s.id === b.ship_id) || null;
      if (ship) {
        const sw = berthW - 30, sh = 90;
        const sx = x + 15, sy = 295;
        drawDockedShip(root, sx, sy, sw, sh, ship);
        svgText(root, sx + sw / 2, sy - 6, `${ship.name} · ${ship.status}`, {
          'text-anchor': 'middle', fill: '#0f172a', 'font-size': 11,
        });
      }

      // cranes (gantries) above the berth
      const cranes = cranesByBerth.get(b.id) || [];
      const cn = cranes.length || 1;
      cranes.forEach((c, k) => {
        const cx = x + (berthW / (cn + 1)) * (k + 1);
        drawCrane(root, cx, c, ship);
      });
    });

    // ── yard blocks ────────────────────────────────────────────────────
    const stackW = 460, stackH = 220;
    drawStack(root, 100, 520, stackW, stackH, 'Imports', snap.yard.imports_staged, '#fde68a', '#d97706');
    drawStack(root, MAP_W - 100 - stackW, 520, stackW, stackH, 'Exports', snap.yard.exports_staged, '#a7f3d0', '#059669');

    // ── gate / trucks ──────────────────────────────────────────────────
    // Two-lane road, each lane scrolls a phase that grows with sim tick.
    //   Outbound lane (top, y≈800): cabs face right, x increases  → moves RIGHT
    //   Inbound  lane (bottom, 865): cabs face left,  x decreases → moves LEFT
    const SPACING = 220;
    const TRACK = MAP_W + 160;          // a bit wider than viewBox so trucks
                                        // can enter/leave off-canvas cleanly
    const phase = (snap.tick * 6) % SPACING;
    const truckCount = Math.min(6, Math.max(2, Math.round((snap.throughput.moves_per_min || 0) / 18) + 2));
    for (let i = 0; i < truckCount; i++) {
      // right-bound: position grows with phase
      const xR = ((i * SPACING + phase) % TRACK) - 80;
      drawTruck(root, xR, 800, 'right');
      // left-bound: position shrinks with phase. Same modulo, then mirror.
      const xL = (TRACK - 80) - ((i * SPACING + phase) % TRACK);
      drawTruck(root, xL, 865, 'left');
    }
    svgText(root, MAP_W - 12, 794, 'Outbound →', { 'text-anchor': 'end', fill: '#475569', 'font-size': 12 });
    svgText(root, 12, 882, '← Inbound', { fill: '#475569', 'font-size': 12 });
  }

  function drawShipIcon(root, x, y, w, h, fill, stroke) {
    // hull (bow on the right)
    const d = `M${x},${y} L${x + w - 12},${y} L${x + w},${y + h / 2} L${x + w - 12},${y + h} L${x},${y + h} Z`;
    svgEl('path', { d, fill, stroke, 'stroke-width': 1 }, root);
    // wheelhouse near the stern (left)
    svgEl('rect', { x: x + w * 0.10, y: y - 8, width: w * 0.16, height: 8, fill: stroke }, root);
    svgEl('rect', { x: x + w * 0.12, y: y - 14, width: w * 0.10, height: 6, fill: stroke, opacity: 0.85 }, root);
  }

  function drawDockedShip(root, x, y, w, h, ship) {
    const damaged = !!ship.damaged;
    const stroke = damaged ? '#991b1b' : '#004F99';
    const fill   = damaged ? '#fecaca' : '#bfdbfe';
    drawShipIcon(root, x, y, w, h, fill, stroke);
    if (damaged) {
      // Pulsing red border + OVERLOAD banner above the hull
      svgEl('rect', {
        x: x - 4, y: y - 6, width: w + 8, height: h + 12,
        fill: 'none', stroke: '#dc2626', 'stroke-width': 3,
        'stroke-dasharray': '6 4',
        class: 'overload-frame',
      }, root);
      svgText(root, x + w / 2, y - 22,
        `⚠ OVERLOAD ${ship.load_count}/${ship.capacity} · DMG ${ship.damage}${ship.condemned ? ' · CONDEMNED' : ''}`,
        { 'text-anchor': 'middle', fill: '#dc2626', 'font-size': 12, 'font-weight': '700' });
    }

    // Build a flat list of containers by type from the *remaining* manifest
    // (both imports and exports). Render them as a single stacked deck so
    // the colors visibly reflect what's left to work.
    const seq = [];
    const importRem = ship.import_types || {};
    const exportRem = ship.export_types || {};
    for (const t of TYPE_ORDER) {
      for (let i = 0; i < (importRem[t] || 0); i++) seq.push(t);
      for (let i = 0; i < (exportRem[t] || 0); i++) seq.push(t);
    }
    const totalRemain = seq.length;
    const totalOrig = Math.max(1, ship.total_imports + ship.total_exports);
    const fillRatio = totalRemain / totalOrig;

    const deckLeft = x + 10;
    const deckRight = x + w - 16;
    const deckW = deckRight - deckLeft;
    const stackW = deckW * fillRatio;
    if (stackW > 4 && totalRemain > 0) {
      const boxW = Math.max(3, Math.min(10, stackW / Math.max(1, totalRemain)));
      const boxH = h - 14;
      let bx = deckLeft;
      for (let i = 0; i < seq.length && bx + boxW <= deckLeft + stackW; i++, bx += boxW + 0.6) {
        const pal = TYPE_COLORS[seq[i]] || TYPE_COLORS['20ft'];
        svgEl('rect', {
          x: bx, y: y + 6, width: boxW, height: boxH * 0.42,
          fill: pal.fill, opacity: 0.92,
        }, root);
        // a thin top row for visual depth when ship is mostly full
        if (fillRatio > 0.45) {
          svgEl('rect', {
            x: bx, y: y + 6 + boxH * 0.42 + 1, width: boxW, height: boxH * 0.30,
            fill: pal.stroke, opacity: 0.55,
          }, root);
        }
      }
    }

    // progress bar under ship: percent worked
    const done = totalOrig - totalRemain;
    const pct = done / totalOrig;
    svgEl('rect', { x, y: y + h + 6, width: w, height: 5, fill: '#e5e7eb', rx: 2 }, root);
    svgEl('rect', { x, y: y + h + 6, width: w * pct, height: 5, fill: '#0072CE', rx: 2 }, root);
    svgText(root, x + w / 2, y + h + 26, `${done} / ${totalOrig}`, {
      'text-anchor': 'middle', fill: '#475569', 'font-size': 11,
    });
    if (ship.ticks_to_deadline < 90) {
      const lvl = ship.ticks_to_deadline < 0 ? '#dc2626' : '#f59e0b';
      svgText(root, x + w / 2, y + h + 42, `Δ ${ship.ticks_to_deadline}t`, {
        'text-anchor': 'middle', fill: lvl, 'font-size': 11,
      });
    }
  }

  function drawCrane(root, cx, crane, ship) {
    // gantry legs + boom; spreader hangs from boom and animates with cycle pct
    const legTop = 226, legBot = 290;
    const boomY = 226;
    const color =
      crane.status === 'busy' ? '#0072CE' :
      crane.status === 'maintenance' ? '#f59e0b' :
      '#64748b';
    svgEl('line', { x1: cx - 24, y1: legTop, x2: cx - 24, y2: legBot, stroke: color, 'stroke-width': 2 }, root);
    svgEl('line', { x1: cx + 24, y1: legTop, x2: cx + 24, y2: legBot, stroke: color, 'stroke-width': 2 }, root);
    svgEl('line', { x1: cx - 28, y1: boomY, x2: cx + 28, y2: boomY, stroke: color, 'stroke-width': 2 }, root);
    // upper boom mast
    svgEl('line', { x1: cx, y1: boomY - 22, x2: cx, y2: boomY, stroke: color, 'stroke-width': 2 }, root);
    svgEl('line', { x1: cx - 8, y1: boomY - 22, x2: cx + 8, y2: boomY - 22, stroke: color, 'stroke-width': 2 }, root);
    // cable + spreader (animates only while busy)
    let cableY = boomY + 10;
    if (crane.status === 'busy' && crane.cycle_total > 0) {
      const t = 1 - (crane.cycle_remaining / crane.cycle_total);  // 0..1
      const phase = Math.sin(t * Math.PI);                        // up-down arc
      cableY = boomY + 8 + phase * 56;
    }
    svgEl('line', { x1: cx, y1: boomY, x2: cx, y2: cableY, stroke: color, 'stroke-width': 1 }, root);
    if (crane.status === 'busy') {
      const pal = TYPE_COLORS[crane.work_type] || { fill: crane.work_dir === 'import' ? '#d97706' : '#059669', stroke: color };
      svgEl('rect', { x: cx - 11, y: cableY, width: 22, height: 13, fill: pal.fill, stroke: pal.stroke, 'stroke-width': 1 }, root);
      if (crane.work_type) {
        svgText(root, cx, cableY + 24, crane.work_type, { 'text-anchor': 'middle', fill: pal.stroke, 'font-size': 9 });
      }
    } else if (crane.status === 'maintenance') {
      svgText(root, cx, boomY - 28, 'M', { 'text-anchor': 'middle', fill: color, 'font-size': 12 });
    }
    svgText(root, cx, legBot + 14, crane.id, { 'text-anchor': 'middle', fill: color, 'font-size': 10 });
  }

  function drawStack(root, x, y, w, h, label, count, fill, stroke) {
    svgText(root, x, y - 10, `${label}: ${count}`, { fill: stroke, 'font-size': 13 });
    svgEl('rect', { x, y, width: w, height: h, fill: '#ffffff', stroke: '#e5e7eb' }, root);
    const visible = Math.min(400, count);
    const cols = 50;
    const rows = Math.ceil(visible / cols) || 1;
    const cw = (w - 6) / cols;
    const ch = (h - 10) / Math.max(rows, 8);
    for (let i = 0; i < visible; i++) {
      const col = i % cols, row = Math.floor(i / cols);
      svgEl('rect', {
        x: x + 3 + col * cw, y: y + h - 5 - (row + 1) * ch + 2,
        width: cw - 1.2, height: ch - 1.2,
        fill, stroke, 'stroke-width': 0.4, opacity: 0.9,
      }, root);
    }
    if (count > visible) {
      svgText(root, x + w - 6, y + 18, `+${count - visible}`, { 'text-anchor': 'end', fill: stroke, 'font-size': 11 });
    }
  }

  function drawTruck(root, x, y, facing) {
    // facing: 'right' → cab on the right (leading the trailer)
    //         'left'  → cab on the left
    const trailerW = 38, trailerH = 14;
    const cabW = 18, cabH = 12;
    let cabX, trailerX;
    if (facing === 'right') {
      trailerX = x;
      cabX = x + trailerW;
    } else {
      cabX = x;
      trailerX = x + cabW;
    }
    // trailer
    svgEl('rect', { x: trailerX, y: y - trailerH, width: trailerW, height: trailerH, fill: '#cbd5e1', stroke: '#059669' }, root);
    // cab
    svgEl('rect', { x: cabX, y: y - cabH, width: cabW, height: cabH, fill: '#94a3b8', stroke: '#94a3b8' }, root);
    // cab window
    const winX = facing === 'right' ? cabX + cabW - 6 : cabX + 2;
    svgEl('rect', { x: winX, y: y - cabH + 2, width: 4, height: 4, fill: '#0072CE', opacity: 0.5 }, root);
    // wheels
    const wheels = facing === 'right'
      ? [trailerX + 6, trailerX + trailerW - 6, cabX + cabW - 4]
      : [cabX + 4, trailerX + 6, trailerX + trailerW - 6];
    for (const wx of wheels) svgEl('circle', { cx: wx, cy: y + 1, r: 2.5, fill: '#94a3b8' }, root);
  }

  /* ── ship detail view ─────────────────────────────────────────────── */
  function renderShipDetail(snap) {
    const root = $('port-map');
    if (!root) return;
    clearSvg(root);

    // Resolve the selected ship; fall back to the most-loaded active ship.
    let ship = snap.ships.find((s) => s.id === selectedShipId) || null;
    if (!ship) {
      const candidates = snap.ships.filter((s) => s.status !== 'departed');
      candidates.sort((a, b) => (b.imports_remaining + b.exports_remaining) - (a.imports_remaining + a.exports_remaining));
      ship = candidates[0] || null;
      if (ship) selectedShipId = ship.id;
    }

    // backdrop
    svgEl('rect', { x: 0, y: 0, width: MAP_W, height: MAP_H, fill: '#ffffff' }, root);

    if (!ship) {
      svgText(root, MAP_W / 2, MAP_H / 2, 'No ships in port', {
        'text-anchor': 'middle', fill: '#94a3b8', 'font-size': 22,
      });
      return;
    }

    // ── header row ─────────────────────────────────────────────────────
    svgText(root, 40, 60, ship.name, { fill: '#0f172a', 'font-size': 32 });
    svgText(root, 40, 92, `${ship.id} · ${ship.status}${ship.berth_id ? ' · berth ' + ship.berth_id : ''}`, {
      fill: '#475569', 'font-size': 14,
    });

    // header stat boxes (right side)
    const stats = [
      { label: 'Imports', val: `${ship.total_imports - ship.imports_remaining}/${ship.total_imports}`, color: '#d97706' },
      { label: 'Exports', val: `${ship.total_exports - ship.exports_remaining}/${ship.total_exports}`, color: '#059669' },
      { label: 'Deadline', val: `${ship.ticks_to_deadline}t`, color: ship.ticks_to_deadline < 0 ? '#dc2626' : ship.ticks_to_deadline < 60 ? '#f59e0b' : '#0072CE' },
    ];
    if (ship.damaged) {
      stats.push({
        label: ship.condemned ? 'CONDEMNED' : 'DAMAGE',
        val: `${ship.damage}  (+${ship.overload})`,
        color: '#dc2626',
      });
    }
    stats.forEach((s, i) => {
      const bx = MAP_W - 660 + i * 220;
      svgEl('rect', { x: bx, y: 30, width: 200, height: 70, fill: '#ffffff', stroke: '#e5e7eb', rx: 4 }, root);
      svgText(root, bx + 100, 54, s.label, { 'text-anchor': 'middle', fill: '#64748b', 'font-size': 12 });
      svgText(root, bx + 100, 86, s.val, { 'text-anchor': 'middle', fill: s.color, 'font-size': 22 });
    });

    // ── ship hero render ───────────────────────────────────────────────
    const sx = 40, sy = 170, sw = MAP_W - 80, sh = 130;
    drawDockedShip(root, sx, sy, sw, sh, ship);

    // ── manifest grid (imports / exports by type) ──────────────────────
    const colY = sy + sh + 80;
    const colH = MAP_H - colY - 40;
    const colW = (MAP_W - 100) / 2;
    drawManifestColumn(root, 40, colY, colW, colH, 'Import manifest',
      ship.import_types_orig || {}, ship.import_types || {}, '#d97706');
    drawManifestColumn(root, 60 + colW, colY, colW, colH, 'Export manifest',
      ship.export_types_orig || {}, ship.export_types || {}, '#059669');

    // ── cranes working this ship ───────────────────────────────────────
    if (ship.berth_id) {
      const workingCranes = snap.cranes.filter((c) => c.berth_id === ship.berth_id);
      const cy = sy + sh + 30;
      svgText(root, 40, cy, 'Cranes assigned', { fill: '#64748b', 'font-size': 12 });
      workingCranes.forEach((c, i) => {
        const cx = 220 + i * 200;
        const dotColor = c.status === 'busy' ? '#0072CE' : c.status === 'maintenance' ? '#f59e0b' : '#64748b';
        svgEl('circle', { cx, cy: cy - 4, r: 5, fill: dotColor }, root);
        const label = c.status === 'busy'
          ? `${c.id} · lifting ${c.work_type || c.work_dir} (${c.cycle_remaining}/${c.cycle_total}t)`
          : c.status === 'maintenance'
            ? `${c.id} · maintenance (${c.remaining_maint}t)`
            : `${c.id} · idle`;
        svgText(root, cx + 12, cy, label, { fill: dotColor, 'font-size': 12 });
      });
    }
  }

  function drawManifestColumn(root, x, y, w, h, title, orig, remaining, accent) {
    svgEl('rect', { x, y, width: w, height: h, fill: '#ffffff', stroke: '#e5e7eb' }, root);
    svgText(root, x + 16, y + 26, title, { fill: accent, 'font-size': 16, 'font-weight': '600' });

    // total bar at top
    const totalOrig = Object.values(orig).reduce((a, b) => a + b, 0) || 0;
    const totalRem = Object.values(remaining).reduce((a, b) => a + b, 0) || 0;
    const done = totalOrig - totalRem;
    svgText(root, x + w - 16, y + 26, `${done}/${totalOrig} · ${totalOrig ? Math.round(100 * done / totalOrig) : 0}%`,
      { 'text-anchor': 'end', fill: '#0f172a', 'font-size': 14 });

    // rows by type
    const rowY0 = y + 56;
    const rowH = (h - 76) / TYPE_ORDER.length;
    TYPE_ORDER.forEach((t, i) => {
      const ry = rowY0 + i * rowH;
      const o = orig[t] || 0;
      const r = remaining[t] || 0;
      const d = o - r;
      const pct = o > 0 ? d / o : 0;
      const pal = TYPE_COLORS[t];
      // type color swatch
      svgEl('rect', { x: x + 16, y: ry + 8, width: 18, height: 18, fill: pal.fill, stroke: pal.stroke }, root);
      svgText(root, x + 44, ry + 22, t, { fill: pal.stroke, 'font-size': 14 });
      // numbers right side
      svgText(root, x + w - 16, ry + 22, `${d} / ${o}`, { 'text-anchor': 'end', fill: '#475569', 'font-size': 14 });
      // progress bar full row width minus padding
      const barX = x + 130, barY = ry + 32, barW = w - 146, barH = 10;
      svgEl('rect', { x: barX, y: barY, width: barW, height: barH, fill: '#ffffff', stroke: '#e5e7eb' }, root);
      svgEl('rect', { x: barX, y: barY, width: barW * pct, height: barH, fill: pal.fill }, root);
      // remaining count just under bar
      svgText(root, x + 44, ry + 50, `${r} remaining`, { fill: '#64748b', 'font-size': 11 });
    });
  }

  /* ── yard detail view ─────────────────────────────────────────────── */
  function renderYardDetail(snap) {
    const root = $('port-map');
    if (!root) return;
    clearSvg(root);
    svgEl('rect', { x: 0, y: 0, width: MAP_W, height: MAP_H, fill: '#ffffff' }, root);
    svgText(root, 40, 60, 'Yard', { fill: '#0f172a', 'font-size': 28, 'font-weight': '600' });
    svgText(root, 40, 88, 'Stack inventory', { fill: '#64748b', 'font-size': 13 });

    // big stat headers
    const headY = 140, headH = 110;
    drawStatBlock(root, 40,            headY, 540, headH, 'Imports staged', snap.yard.imports_staged, '#d97706', 'awaiting lorry collection');
    drawStatBlock(root, MAP_W - 580,   headY, 540, headH, 'Exports staged', snap.yard.exports_staged, '#059669', 'awaiting load to ship');

    // big stacks below
    const stackY = 280, stackH = MAP_H - stackY - 60;
    drawStack(root, 40,                  stackY, 540, stackH, '',
      snap.yard.imports_staged, '#fde68a', '#d97706');
    drawStack(root, MAP_W - 580,         stackY, 540, stackH, '',
      snap.yard.exports_staged, '#a7f3d0', '#059669');

    // throughput summary in the middle gap
    const midX = (MAP_W / 2) - 30, midW = 60;
    const arrowGap = 18;
    // crane → yard arrow on the import side
    svgEl('path', { d: `M${midX - 50},420 L${midX - 10},420`, stroke: '#d97706', 'stroke-width': 2, fill: 'none', 'marker-end': 'url(#arr-imp)' }, root);
    // yard → crane arrow on the export side
    svgEl('path', { d: `M${midX + 60},520 L${midX + 100},520`, stroke: '#059669', 'stroke-width': 2, fill: 'none' }, root);

    // throughput readout
    svgEl('rect', { x: midX - 36, y: 280, width: 132, height: 120, fill: '#ffffff', stroke: '#e5e7eb' }, root);
    svgText(root, midX + 30, 312, 'Moves/min', { 'text-anchor': 'middle', fill: '#64748b', 'font-size': 12 });
    svgText(root, midX + 30, 358, String(snap.throughput.moves_per_min || 0), { 'text-anchor': 'middle', fill: '#0072CE', 'font-size': 36 });
    svgText(root, midX + 30, 384, `this tick: ${snap.throughput.moves_this_tick}`, { 'text-anchor': 'middle', fill: '#475569', 'font-size': 11 });
  }

  function drawStatBlock(root, x, y, w, h, label, value, color, sub) {
    svgEl('rect', { x, y, width: w, height: h, fill: '#ffffff', stroke: '#e5e7eb', rx: 4 }, root);
    svgText(root, x + 24, y + 32, label, { fill: '#64748b', 'font-size': 13 });
    svgText(root, x + 24, y + 86, String(value), { fill: color, 'font-size': 52 });
    svgText(root, x + w - 16, y + 86, sub, { 'text-anchor': 'end', fill: '#64748b', 'font-size': 12 });
  }

  /* ── throughput view ──────────────────────────────────────────────── */
  function renderThroughput(snap) {
    const root = $('port-map');
    if (!root) return;
    clearSvg(root);
    svgEl('rect', { x: 0, y: 0, width: MAP_W, height: MAP_H, fill: '#ffffff' }, root);

    svgText(root, 40, 60, 'Throughput', { fill: '#0f172a', 'font-size': 28, 'font-weight': '600' });
    svgText(root, 40, 88, 'Cumulative score over time', { fill: '#64748b', 'font-size': 13 });

    // KPI strip
    const kpi = [
      { label: 'Imports',   val: snap.score.imports,  color: '#d97706' },
      { label: 'Exports',   val: snap.score.exports,  color: '#059669' },
      { label: 'Missed',    val: snap.score.missed_imports + snap.score.missed_exports, color: '#dc2626' },
      { label: 'Moves/min', val: snap.throughput.moves_per_min, color: '#0072CE' },
    ];
    kpi.forEach((k, i) => {
      const bx = 40 + i * 290;
      svgEl('rect', { x: bx, y: 120, width: 270, height: 80, fill: '#ffffff', stroke: '#e5e7eb', rx: 4 }, root);
      svgText(root, bx + 16, 148, k.label, { fill: '#64748b', 'font-size': 12 });
      svgText(root, bx + 270 - 16, 182, String(k.val), { 'text-anchor': 'end', fill: k.color, 'font-size': 32 });
    });

    // chart area
    const cx0 = 60, cy0 = 240, cw = MAP_W - 120, ch = MAP_H - cy0 - 80;
    svgEl('rect', { x: cx0, y: cy0, width: cw, height: ch, fill: '#ffffff', stroke: '#e5e7eb' }, root);

    const hist = snap.score_history || [];
    if (hist.length < 2) {
      svgText(root, cx0 + cw / 2, cy0 + ch / 2, 'collecting samples…',
        { 'text-anchor': 'middle', fill: '#94a3b8', 'font-size': 18 });
      return;
    }
    const t0 = hist[0].tick, t1 = hist[hist.length - 1].tick;
    const tSpan = Math.max(1, t1 - t0);
    const maxY = Math.max(
      hist[hist.length - 1].imports + hist[hist.length - 1].exports,
      10,
    );
    const tickX = (t) => cx0 + ((t - t0) / tSpan) * cw;
    const valY = (v) => cy0 + ch - (v / maxY) * (ch - 20) - 10;

    // gridlines
    for (let i = 0; i <= 4; i++) {
      const y = cy0 + (ch * i) / 4;
      svgEl('line', { x1: cx0, y1: y, x2: cx0 + cw, y2: y, stroke: '#e5e7eb', 'stroke-width': 0.5 }, root);
      svgText(root, cx0 - 10, y + 4, String(Math.round(maxY * (1 - i / 4))),
        { 'text-anchor': 'end', fill: '#94a3b8', 'font-size': 11 });
    }

    // lines for imports, exports, missed, total
    const series = [
      { key: (h) => h.imports + h.exports, color: '#0072CE', label: 'total score', w: 2.4 },
      { key: (h) => h.imports,             color: '#d97706', label: 'imports',     w: 1.6 },
      { key: (h) => h.exports,             color: '#059669', label: 'exports',     w: 1.6 },
      { key: (h) => h.missed,              color: '#dc2626', label: 'missed',      w: 1.4 },
    ];
    series.forEach((s) => {
      let d = '';
      for (let i = 0; i < hist.length; i++) {
        const px = tickX(hist[i].tick).toFixed(1);
        const py = valY(s.key(hist[i])).toFixed(1);
        d += (i === 0 ? 'M' : 'L') + px + ',' + py + ' ';
      }
      svgEl('path', { d, fill: 'none', stroke: s.color, 'stroke-width': s.w }, root);
    });

    // legend
    series.forEach((s, i) => {
      const lx = cx0 + 18 + i * 200;
      const ly = cy0 + 24;
      svgEl('rect', { x: lx, y: ly - 8, width: 14, height: 4, fill: s.color }, root);
      svgText(root, lx + 22, ly - 2, s.label, { fill: s.color, 'font-size': 12, 'letter-spacing': '0.06em' });
    });

    // x-axis tick range
    svgText(root, cx0, cy0 + ch + 22, `t${t0}`, { fill: '#64748b', 'font-size': 11 });
    svgText(root, cx0 + cw, cy0 + ch + 22, `t${t1}`, { 'text-anchor': 'end', fill: '#64748b', 'font-size': 11 });
  }

  /* ── legends per view ────────────────────────────────────────────── */
  function legendOverview() {
    return [
      { cls: 'lg-ship',        label: 'ship' },
      { cls: 'lg-crane-busy',  label: 'lifting' },
      { cls: 'lg-crane-idle',  label: 'idle' },
      { cls: 'lg-crane-maint', label: 'maint' },
      { cls: 'lg-imp',         label: 'imports' },
      { cls: 'lg-exp',         label: 'exports' },
    ];
  }
  function legendShipDetail() {
    return TYPE_ORDER.map((t) => ({ swatch: TYPE_COLORS[t].fill, label: t }));
  }
  function legendYard() {
    return [
      { swatch: '#d97706', label: 'imports staged (awaiting lorry collection)' },
      { swatch: '#059669', label: 'exports staged (awaiting ship load)' },
    ];
  }
  function legendThroughput() {
    return [
      { swatch: '#0072CE', label: 'total score' },
      { swatch: '#d97706', label: 'imports' },
      { swatch: '#059669', label: 'exports' },
      { swatch: '#dc2626', label: 'missed' },
    ];
  }

  /* ── per-view toolbars ───────────────────────────────────────────── */
  function buildShipToolbar(snap) {
    const root = $('view-toolbar');
    if (!root) return;
    root.innerHTML = '';
    const label = document.createElement('label');
    label.className = 'tb-label';
    label.textContent = 'ship:';
    const sel = document.createElement('select');
    sel.className = 'tb-select';
    const candidates = snap.ships.filter((s) => s.status !== 'departed');
    if (!candidates.length) {
      const o = document.createElement('option');
      o.value = ''; o.textContent = '— no ships —';
      sel.appendChild(o);
    } else {
      // ensure selected one is in list
      if (!candidates.find((s) => s.id === selectedShipId)) {
        selectedShipId = candidates[0].id;
      }
      for (const s of candidates) {
        const o = document.createElement('option');
        o.value = s.id;
        o.textContent = `${s.id}  ${s.name}  ·  ${s.status}`;
        if (s.id === selectedShipId) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => {
        selectedShipId = sel.value;
        // immediate re-render
        if (lastSnapshot) renderView(lastSnapshot);
      });
    }
    label.appendChild(sel);
    root.appendChild(label);
  }

  function renderLegend(items) {
    const root = $('view-legend');
    if (!root) return;
    root.innerHTML = '';
    for (const it of items) {
      const span = document.createElement('span');
      span.className = 'lg';
      if (it.cls) span.classList.add(it.cls);
      if (it.swatch && !it.cls) {
        const sw = document.createElement('span');
        sw.className = 'lg-swatch';
        sw.style.background = it.swatch;
        sw.style.borderColor = it.swatch;
        span.appendChild(sw);
      }
      span.appendChild(document.createTextNode(it.label));
      root.appendChild(span);
    }
  }

  function setView(name) {
    if (!VIEWS[name]) return;
    activeView = name;
    document.querySelectorAll('.view-tab').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.view === name);
    });
    const tb = $('view-toolbar');
    if (tb) tb.innerHTML = '';
    if (lastSnapshot) renderView(lastSnapshot);
  }

  function renderView(snap) {
    updateMapDimensions();
    const v = VIEWS[activeView] || VIEWS.overview;
    if (v.buildToolbar) v.buildToolbar(snap);
    v.render(snap);
    if (v.legend) renderLegend(v.legend());
  }

  function bindViewTabs() {
    document.querySelectorAll('.view-tab').forEach((btn) => {
      btn.addEventListener('click', () => setView(btn.dataset.view));
    });
  }

  function connectWebSocket() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/state`);
    let alive = false;
    ws.addEventListener('open', () => { alive = true; });
    ws.addEventListener('message', (ev) => {
      try { applySnapshot(JSON.parse(ev.data)); } catch (_) { /* ignore */ }
    });
    ws.addEventListener('close', () => {
      // Reconnect with backoff; fall back to polling immediately.
      setStatus('down');
      if (alive) pollOnce();
      setTimeout(connectWebSocket, 3000);
    });
    ws.addEventListener('error', () => ws.close());
  }

  async function pollOnce() {
    try {
      const resp = await fetch('/api/state', { credentials: 'same-origin' });
      if (resp.status === 401) { window.location = '/login'; return; }
      applySnapshot(await resp.json());
    } catch (_) {/* ignore */}
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindCommands();
    bindViewTabs();
    bindDrawer();
    setStatus('down');
    pollOnce();
    connectWebSocket();
    setInterval(clockTick, 1000);
    clockTick();
    // Re-render the map when the window resizes so it keeps filling the wrapper.
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (lastSnapshot) renderView(lastSnapshot);
      }, 100);
    });
  });
})();
