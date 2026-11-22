'use strict';
// PixelBlame UI: vanilla JS, hash routing, canvas for heatmaps and charts.

const $main = document.getElementById('main');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const api = (p) => fetch(p).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} ${p}`))));
const COLOR_DOT = { red: '#d23a3a', blue: '#2f62c9', yellow: '#e8c52a', green: '#2f9a4c', purple: '#7a3fb5', orange: '#e07a1f', pink: '#d94f9c', teal: '#1fa7a0' };
const FAMILY_COLORS = { jpeg: '#4f46e5', resize: '#0f766e', blur: '#c2410c', brightness: '#a21caf', rotate: '#4d7c0f', crop: '#0369a1' };
const FAMILY_DASH = { jpeg: [], resize: [6, 3], blur: [], brightness: [2, 3], rotate: [8, 3, 2, 3], crop: [] };
const FAMILY_MARK = { jpeg: 'circle', resize: 'square', blur: 'diamond', brightness: 'circle', rotate: 'square', crop: 'triangle' };

function badge(c) {
  if (c.error) return `<span class="badge err">Error</span>`;
  if (c.cache === 'exact') return `<span class="badge exact">Cache exact</span>`;
  if (c.cache === 'near') return `<span class="badge near" title="dHash distance ${c.distance} ≤ calibrated threshold ${c.threshold}">Cache near · d=${c.distance} ≤ ${c.threshold}</span>`;
  return `<span class="badge live">Live</span>`;
}
const chip = (it) => `<span class="chip"><span class="dot" style="background:${COLOR_DOT[it.color] || '#bbb'}"></span>${esc(it.name)}</span>`;
const empty = (title, cmd) => `<div class="card empty"><h2>${esc(title)}</h2><p>Run <code>${esc(cmd)}</code> then refresh this page.</p></div>`;

function setupCanvas(canvas, cssWidth, cssHeight) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  canvas.style.aspectRatio = `${cssWidth} / ${cssHeight}`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

async function refreshPill() {
  try {
    const s = await api('/api/summary');
    const c = s.calibration;
    document.getElementById('cal-pill').innerHTML =
      !c ? 'Near cache: <b>off</b> (not calibrated)'
      : c.threshold === null ? 'Near cache: <b>off</b> (calibration found no safe distance)'
      : `Near cache: <b>on</b>, threshold ${c.threshold}`;
  } catch { /* server might be starting */ }
}

// ---------- Runs ----------
async function renderRuns(params) {
  const [runs, summary] = await Promise.all([api('/api/runs'), api('/api/summary')]);
  if (!runs.length) {
    $main.innerHTML = `<h1>Runs</h1><p class="sub">Every recorded model call, with how it was served.</p>${empty('No runs yet', 'npm run demo')}`;
    return;
  }
  const by = Object.fromEntries(summary.counts.map((c) => [c.cache, c]));
  const n = (k) => by[k]?.n ?? 0;
  const total = n('live') + n('exact') + n('near');
  const selected = params.get('id') || runs[0].id;
  $main.innerHTML = `
    <h1>Runs</h1><p class="sub">Every recorded model call, with how it was served.</p>
    <div class="stats" role="list">
      <div class="stat" role="listitem"><div class="n">${total}</div><div class="l">calls recorded</div></div>
      <div class="stat" role="listitem"><div class="n">${n('live')}</div><div class="l">live model calls</div></div>
      <div class="stat" role="listitem"><div class="n">${n('exact')}</div><div class="l">exact cache hits</div></div>
      <div class="stat" role="listitem"><div class="n">${n('near')}</div><div class="l">near cache hits</div></div>
    </div>
    <div class="grid2">
      <section class="card" aria-labelledby="runs-h"><h2 id="runs-h">Runs</h2><ul class="list" id="run-list"></ul></section>
      <section class="card" aria-live="polite" id="run-detail"></section>
    </div>`;
  const list = document.getElementById('run-list');
  list.innerHTML = runs
    .map((r) => `<li><button data-id="${esc(r.id)}" aria-current="${r.id === selected}">${esc(r.name)}<span class="meta">${esc(r.kind)} · ${r.call_count} call${r.call_count === 1 ? '' : 's'} · ${new Date(r.created_at).toLocaleString()}</span></button></li>`)
    .join('');
  list.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]');
    if (b) location.hash = `#/runs?id=${encodeURIComponent(b.dataset.id)}`;
  });
  const { run, calls } = await api(`/api/runs/${encodeURIComponent(selected)}`);
  const shown = calls.slice(0, 60);
  document.getElementById('run-detail').innerHTML = `
    <h2>${esc(run.name)} <span class="small" style="color:var(--muted);font-weight:400">${esc(run.id)}</span></h2>
    ${calls.length ? `<ol class="timeline">${shown
      .map(
        (c) => `<li class="step">
          <img src="/api/blobs/${esc(c.images[0])}" alt="Input photo for step ${c.seq + 1}" />
          <div>
            <div class="head"><strong>Step ${c.seq + 1}</strong>${badge(c)}<span class="small">${c.latencyMs} ms · ${c.cache === 'live' ? `${c.tokens.input + c.tokens.output} tokens` : 'no tokens spent'}</span></div>
            <div class="chips">${(c.output?.items || []).map(chip).join('') || '<span class="small">no items</span>'}</div>
            ${c.output?.reasoning ? `<div class="small" style="margin-top:6px">${esc(c.output.reasoning)}</div>` : ''}
            ${c.error ? `<div class="warnbox">${esc(c.error)}</div>` : ''}
          </div></li>`,
      )
      .join('')}</ol>${calls.length > shown.length ? `<p class="note">Showing the first ${shown.length} of ${calls.length} steps.</p>` : ''}`
      : '<p class="note">This run has no calls.</p>'}`;
}

// ---------- Blame ----------
function drawBlame(canvas, img, result, item) {
  const W = Math.min(640, canvas.parentElement.clientWidth - 24);
  const H = (W * result.height) / result.width;
  const ctx = setupCanvas(canvas, W, H);
  ctx.drawImage(img, 0, 0, W, H);
  const n = result.grid;
  const cell = (i) => {
    const r = Math.floor(i / n), c = i % n;
    const x0 = Math.round((c * W) / n), x1 = Math.round(((c + 1) * W) / n);
    const y0 = Math.round((r * H) / n), y1 = Math.round(((r + 1) * H) / n);
    return [x0, y0, x1 - x0, y1 - y0];
  };
  // dim the photo slightly so the heat reads clearly
  ctx.fillStyle = 'rgba(246,243,237,.35)';
  ctx.fillRect(0, 0, W, H);
  item.heat.forEach((h, i) => {
    if (h < 0.2) return; // small ridge weights come from cells only ever masked alongside the cause
    const [x, y, w, hh] = cell(i);
    ctx.fillStyle = `rgba(234,88,12,${(0.1 + 0.7 * h).toFixed(3)})`;
    ctx.fillRect(x, y, w, hh);
  });
  ctx.strokeStyle = 'rgba(34,32,28,.25)';
  ctx.lineWidth = 1;
  for (let i = 1; i < n; i++) {
    ctx.beginPath(); ctx.moveTo((i * W) / n, 0); ctx.lineTo((i * W) / n, H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, (i * H) / n); ctx.lineTo(W, (i * H) / n); ctx.stroke();
  }
  // minimal region outline: trace only the outer edges of the selected cells
  const set = new Set(item.minimal.cells);
  ctx.strokeStyle = '#4f46e5';
  ctx.lineWidth = 4;
  ctx.setLineDash(item.minimal.proven ? [] : [8, 6]);
  for (const i of set) {
    const [x, y, w, h] = cell(i);
    const r = Math.floor(i / n), c = i % n;
    const edges = [
      [r === 0 || !set.has(i - n), x, y, x + w, y],
      [r === n - 1 || !set.has(i + n), x, y + h, x + w, y + h],
      [c === 0 || !set.has(i - 1), x, y, x, y + h],
      [c === n - 1 || !set.has(i + 1), x + w, y, x + w, y + h],
    ];
    for (const [draw, ax, ay, bx, by] of edges) {
      if (!draw) continue;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    }
  }
  ctx.setLineDash([]);
  ctx.font = '600 12px system-ui, sans-serif';
  for (let i = 0; i < n * n; i++) {
    const [x, y] = cell(i);
    ctx.fillStyle = 'rgba(34,32,28,.55)';
    ctx.fillText(String(i), x + 6, y + 16);
  }
}

async function renderBlame(params) {
  const list = await api('/api/blame');
  if (!list.length) {
    $main.innerHTML = `<h1>Image Blame</h1><p class="sub">Which part of the photo caused each item in the output.</p>${empty('No blame results yet', 'npm run demo:blame')}`;
    return;
  }
  const id = params.get('id') || list[0].blameId;
  const result = await api(`/api/blame/${encodeURIComponent(id)}`);
  const itemKey = params.get('item') || result.items[0]?.key;
  const item = result.items.find((i) => i.key === itemKey) || result.items[0];
  $main.innerHTML = `
    <h1>Image Blame</h1><p class="sub">Which part of the photo caused each item in the output. Black-box: only occluded copies of the photo were sent to the model.</p>
    <div class="toolbar">
      <label class="inline" for="blame-sel">Result
        <select id="blame-sel">${list.map((b) => `<option value="${esc(b.blameId)}" ${b.blameId === id ? 'selected' : ''}>${esc(b.blameId)} · ${b.grid}×${b.grid} · ${new Date(b.createdAt).toLocaleString()}</option>`).join('')}</select>
      </label>
    </div>
    ${result.items.length ? `
    <div class="items" role="group" aria-label="Choose an output item">${result.items
      .map((it) => `<button data-key="${esc(it.key)}" aria-pressed="${it.key === item.key}"><span class="dot" style="background:${COLOR_DOT[it.color] || '#bbb'}"></span>${esc(it.name)}</button>`)
      .join('')}</div>
    <div class="grid-blame">
      <div class="canvas-wrap">
        <canvas id="blame-canvas" role="img" aria-label="Photo with heatmap for ${esc(item.name)}; minimal region cells ${item.minimal.cells.join(', ') || 'none'}"></canvas>
        <div class="legend"><span><span class="ramp"></span> attribution (low → high)</span><span><span class="sw" style="background:none;border:3px solid #4f46e5;height:12px"></span> minimal region${item.minimal.proven ? '' : ' (dashed = not proven minimal)'}</span></div>
      </div>
      <aside class="card" aria-labelledby="blame-item-h">
        <h2 id="blame-item-h">${esc(item.name)}</h2>
        <dl class="kv">
          <dt>Category</dt><dd>${esc(item.category)}</dd>
          <dt>Minimal region</dt><dd>${item.minimal.cells.length ? `cells ${item.minimal.cells.join(', ')}` : '—'}</dd>
          <dt>Found by</dt><dd>${item.minimal.method === 'ddmin' ? 'ddmin (joint effect)' : item.minimal.method === 'single-cell' ? 'single-cell occlusion' : 'not found'}</dd>
          <dt>Proven minimal</dt><dd>${item.minimal.proven ? 'yes' : 'no (budget)'}</dd>
          <dt>Cells alone</dt><dd>${item.singleCells.length ? item.singleCells.join(', ') : 'none remove it alone'}</dd>
        </dl>
        <hr style="border:none;border-top:1px solid var(--border);margin:14px 0" />
        <dl class="kv">
          <dt>Grid / fill</dt><dd>${result.grid}×${result.grid} · ${esc(result.fill)}</dd>
          <dt>Live calls</dt><dd>${result.liveCalls} of ${result.maxCalls} budget</dd>
          <dt>From cache</dt><dd>${result.cachedCalls}</dd>
          <dt>Masks tested</dt><dd>${result.masksTested}</dd>
          <dt>Model</dt><dd>${esc(result.model)}</dd>
        </dl>
        ${result.budgetExhausted ? '<div class="warnbox">Budget exhausted: some items are partial. Re-run with a higher <code>--max-calls</code>; cached masks are free.</div>' : ''}
        ${result.fillArtifacts.length ? `<div class="warnbox">The occlusion fill itself made the model report new items in ${result.fillArtifacts.length} mask(s).</div>` : ''}
        <p class="note">Heat = each cell's weight in a ridge-regression fit of “item disappeared” on which cells were masked, over all ${result.masksTested} masks tested.</p>
      </aside>
    </div>` : '<div class="card empty">The baseline output had no items to blame.</div>'}`;
  document.getElementById('blame-sel').addEventListener('change', (e) => (location.hash = `#/blame?id=${encodeURIComponent(e.target.value)}`));
  if (!result.items.length) return;
  document.querySelector('.items').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-key]');
    if (b) location.hash = `#/blame?id=${encodeURIComponent(id)}&item=${encodeURIComponent(b.dataset.key)}`;
  });
  const img = new Image();
  img.onload = () => {
    const canvas = document.getElementById('blame-canvas');
    const draw = () => drawBlame(canvas, img, result, item);
    draw();
    window.onresize = draw;
  };
  img.src = `/api/blobs/${result.imageSha}`;
  if (params.get('item')) document.querySelector(`.items button[aria-pressed="true"]`)?.focus();
}

// ---------- Drift ----------
function marker(ctx, shape, x, y, r) {
  ctx.beginPath();
  if (shape === 'square') ctx.rect(x - r, y - r, 2 * r, 2 * r);
  else if (shape === 'diamond') { ctx.moveTo(x, y - r - 1); ctx.lineTo(x + r + 1, y); ctx.lineTo(x, y + r + 1); ctx.lineTo(x - r - 1, y); ctx.closePath(); }
  else if (shape === 'triangle') { ctx.moveTo(x, y - r - 1); ctx.lineTo(x + r + 1, y + r); ctx.lineTo(x - r - 1, y + r); ctx.closePath(); }
  else ctx.arc(x, y, r, 0, Math.PI * 2);
}

function drawDrift(canvas, drift, calibration, visible) {
  const W = Math.min(820, canvas.parentElement.clientWidth - 24);
  const H = Math.round(W * 0.52);
  const ctx = setupCanvas(canvas, W, H);
  const pad = { l: 52, r: 18, t: 18, b: 44 };
  const maxD = Math.max(8, ...drift.families.flatMap((f) => f.points.map((p) => p.distance)));
  const xMax = Math.ceil(maxD / 4) * 4;
  const X = (d) => pad.l + (d / xMax) * (W - pad.l - pad.r);
  const Y = (v) => H - pad.b - v * (H - pad.t - pad.b);
  ctx.fillStyle = '#fffdf9';
  ctx.fillRect(0, 0, W, H);
  ctx.font = '12px system-ui, sans-serif';
  ctx.strokeStyle = '#ebe5da';
  ctx.fillStyle = '#615b51';
  ctx.lineWidth = 1;
  for (let v = 0; v <= 1.0001; v += 0.25) {
    ctx.beginPath(); ctx.moveTo(pad.l, Y(v)); ctx.lineTo(W - pad.r, Y(v)); ctx.stroke();
    ctx.textAlign = 'right'; ctx.fillText(v.toFixed(2), pad.l - 8, Y(v) + 4);
  }
  const xStep = xMax <= 16 ? 2 : xMax <= 40 ? 4 : 8;
  for (let d = 0; d <= xMax; d += xStep) {
    ctx.textAlign = 'center'; ctx.fillText(String(d), X(d), H - pad.b + 18);
  }
  ctx.fillStyle = '#22201c';
  ctx.textAlign = 'center';
  ctx.fillText('perceptual distance (dHash Hamming, 0–64)', (pad.l + W - pad.r) / 2, H - 6);
  ctx.save(); ctx.translate(14, (pad.t + H - pad.b) / 2); ctx.rotate(-Math.PI / 2); ctx.fillText('output change (0–1)', 0, 0); ctx.restore();

  if (calibration && calibration.threshold !== null) {
    const x = X(calibration.threshold);
    ctx.fillStyle = 'rgba(79,70,229,.08)';
    ctx.fillRect(pad.l, pad.t, x - pad.l, H - pad.t - pad.b);
    ctx.strokeStyle = '#4f46e5'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, H - pad.b); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#4f46e5'; ctx.textAlign = 'left'; ctx.font = '600 12px system-ui, sans-serif';
    ctx.fillText(`near-match threshold = ${calibration.threshold}`, x + 6, pad.t + 12);
  }

  for (const f of drift.families) {
    if (!visible.has(f.family)) continue;
    const color = FAMILY_COLORS[f.family] || '#555';
    const pts = [...f.points].sort((a, b) => a.distance - b.distance || a.step - b.step);
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash(FAMILY_DASH[f.family] || []);
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(X(p.distance), Y(p.change)) : ctx.moveTo(X(p.distance), Y(p.change))));
    ctx.stroke(); ctx.setLineDash([]);
    for (const p of pts) {
      ctx.fillStyle = color; marker(ctx, FAMILY_MARK[f.family], X(p.distance), Y(p.change), 4); ctx.fill();
    }
    if (f.tippingPoint) {
      const x = X(f.tippingPoint.distance), y = Y(f.tippingPoint.change);
      ctx.strokeStyle = color; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = color; ctx.font = '600 12px system-ui, sans-serif';
      ctx.textAlign = x > W - 140 ? 'right' : 'left';
      ctx.fillText(`${f.family} tips at ${f.tippingPoint.label}`, x + (ctx.textAlign === 'right' ? -13 : 13), y - 10);
    }
  }
}

async function renderDrift(params) {
  const { results, calibration } = await api('/api/drift');
  if (!results.length) {
    $main.innerHTML = `<h1>Drift Map</h1><p class="sub">How far an image can change before the model's answer does.</p>${empty('No Drift Map results yet', 'npm run demo:drift')}`;
    return;
  }
  const id = params.get('id') || results[0].driftId;
  const drift = results.find((r) => r.driftId === id) || results[0];
  const visible = new Set(drift.families.map((f) => f.family));
  const calText = !calibration
    ? 'Not calibrated: near matching is OFF. Run <code>pixelblame calibrate</code>.'
    : calibration.threshold === null
      ? `Calibrated from ${calibration.points} points: no safe distance, so near matching is OFF. ${esc(calibration.note)}`
      : `Threshold <b>${calibration.threshold}</b> from ${calibration.points} points across ${calibration.driftIds.length} drift run(s). ${esc(calibration.note)}`;
  $main.innerHTML = `
    <h1>Drift Map</h1><p class="sub">How far an image can change before the model's answer does. Each line is one perturbation family, mildest to strongest.</p>
    <div class="toolbar">
      <label class="inline" for="drift-sel">Drift run
        <select id="drift-sel">${results.map((r) => `<option value="${esc(r.driftId)}" ${r.driftId === drift.driftId ? 'selected' : ''}>${esc(r.driftId)} · ${esc(r.sourceSha.slice(0, 8))} · ${new Date(r.createdAt).toLocaleString()}</option>`).join('')}</select>
      </label>
      <fieldset style="border:none;padding:0;margin:0;display:flex;gap:10px;flex-wrap:wrap" aria-label="Families shown">
        ${drift.families.map((f) => `<label class="inline"><input type="checkbox" data-fam="${esc(f.family)}" checked /><span class="sw" style="display:inline-block;width:14px;height:4px;background:${FAMILY_COLORS[f.family]}"></span>${esc(f.family)}</label>`).join('')}
      </fieldset>
    </div>
    <div class="canvas-wrap"><canvas id="drift-canvas" role="img" aria-label="Line chart of output change versus perceptual distance per perturbation family. Data table below."></canvas>
      <p class="note">${calText}</p></div>
    <div class="grid-even" style="margin-top:20px">
      <section class="card"><h2>Tipping points</h2>
        <table><thead><tr><th>Family</th><th>First change at</th><th>Distance</th><th>Change</th></tr></thead><tbody>
        ${drift.families.map((f) => `<tr><td><span class="sw" style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${FAMILY_COLORS[f.family]};vertical-align:-1px;margin-right:6px"></span>${esc(f.family)}</td>${f.tippingPoint ? `<td>${esc(f.tippingPoint.label)}</td><td class="num">${f.tippingPoint.distance}</td><td class="num">${f.tippingPoint.change.toFixed(2)}</td>` : '<td colspan="3" style="color:var(--muted)">never changed</td>'}</tr>`).join('')}
        </tbody></table></section>
      <section class="card"><h2>Baseline output</h2><div class="chips">${drift.baseline.items.map(chip).join('')}</div>
        <p class="note">${drift.liveCalls} live calls, ${drift.cachedCalls} from cache · model ${esc(drift.model)}</p>
        <details style="margin-top:10px"><summary>All points</summary>
          <table><thead><tr><th>Family</th><th>Step</th><th>Distance</th><th>Change</th></tr></thead><tbody>
          ${drift.families.flatMap((f) => f.points.map((p) => `<tr><td>${esc(f.family)}</td><td>${esc(p.label)}</td><td class="num">${p.distance}</td><td class="num">${p.change.toFixed(2)}</td></tr>`)).join('')}
          </tbody></table></details></section>
    </div>`;
  const canvas = document.getElementById('drift-canvas');
  const draw = () => drawDrift(canvas, drift, calibration, visible);
  draw();
  window.onresize = draw;
  document.getElementById('drift-sel').addEventListener('change', (e) => (location.hash = `#/drift?id=${encodeURIComponent(e.target.value)}`));
  document.querySelectorAll('input[data-fam]').forEach((cb) =>
    cb.addEventListener('change', () => {
      cb.checked ? visible.add(cb.dataset.fam) : visible.delete(cb.dataset.fam);
      draw();
    }),
  );
}

// ---------- router ----------
const PAGES = { runs: renderRuns, blame: renderBlame, drift: renderDrift };
async function route() {
  const [path, query] = (location.hash.slice(2) || 'runs').split('?');
  const page = PAGES[path] ? path : 'runs';
  document.querySelectorAll('nav a').forEach((a) => (a.dataset.page === page ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  document.title = `PixelBlame · ${page[0].toUpperCase()}${page.slice(1)}`;
  window.onresize = null;
  try {
    await PAGES[page](new URLSearchParams(query || ''));
  } catch (e) {
    $main.innerHTML = `<div class="card empty"><h2>Couldn't load this page</h2><p>${esc(e.message)}. Is the server running? Try <code>npm run dev</code>.</p></div>`;
  }
  refreshPill();
}
window.addEventListener('hashchange', route);
route();
