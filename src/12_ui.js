/* ============================================================
   JIZURA — editor UI
   ============================================================ */
(() => {
'use strict';
if (!document.getElementById('app')) return;          // engine-only pages (tests)
const $ = id => document.getElementById(id);
const LS_KEY = 'jizura.project.v1';
const HUD_CHARS = '0123456789:./-_()【】・No.LYRICRECUNTITLEDXYlinebpminterlude—─／ ';
const ICON = {
  dice: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="2" width="12" height="12" rx="2"/><circle cx="5.5" cy="5.5" r="1" fill="currentColor"/><circle cx="10.5" cy="10.5" r="1" fill="currentColor"/><circle cx="10.5" cy="5.5" r="1" fill="currentColor"/><circle cx="5.5" cy="10.5" r="1" fill="currentColor"/></svg>',
  lock: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/></svg>',
};

const S = { project: null, plan: null, audio: null, renderer: new J.Renderer(), playing: false, t: 0, t0: 0, loop: true, need: true, exporting: null, tap: null, slow: false, lineEls: [], curLine: -2 };
window._S = S;  // expose for timeline module

/* WebAudio player (works inside sandboxed pages where blob media may be blocked) */
const AP = {
  ctx: null, src: null, startAt: 0, gain: null, vol: 0.8, muted: false,
  play(buffer, offset) {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.stop();
    if (!this.gain) { this.gain = this.ctx.createGain(); this.gain.connect(this.ctx.destination); this.applyVol(); }
    const s = this.ctx.createBufferSource(); s.buffer = buffer; s.connect(this.gain);
    const off = Math.max(0, Math.min(offset, buffer.duration - 0.01));
    s.start(0, off); this.src = s; this.startAt = this.ctx.currentTime - off;
  },
  stop() { if (this.src) { try { this.src.stop(); } catch (e) {} try { this.src.disconnect(); } catch (e) {} this.src = null; } },
  time() { return this.ctx ? this.ctx.currentTime - this.startAt : 0; },
  /* preview volume only (exports keep the original level) */
  setVol(v, muted) { if (v != null) this.vol = Math.max(0, Math.min(1, v)); if (muted != null) this.muted = !!muted; this.applyVol(); },
  applyVol() { if (!this.gain) return; const v = this.muted ? 0 : this.vol * this.vol; try { this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.015); } catch (e) { this.gain.gain.value = v; } },
};
/* プレビュー音量: remembered per browser */
function initVolume() {
  const el = $('vol'), mb = $('btnMute'); if (!el || !mb) return;
  let v = 0.8, m = false;
  try { const o = JSON.parse(localStorage.getItem('jizura.previewVolume') || 'null'); if (o) { v = +o.v; m = !!o.m; } } catch (e) {}
  if (!(v >= 0 && v <= 1)) v = 0.8;
  const show = () => { el.value = Math.round(AP.vol * 100); mb.textContent = AP.muted || AP.vol === 0 ? '消音' : '音量'; mb.setAttribute('aria-pressed', String(AP.muted)); el.title = '音量 ' + Math.round(AP.vol * 100) + '%'; };
  const save = () => { try { localStorage.setItem('jizura.previewVolume', JSON.stringify({ v: AP.vol, m: AP.muted })); } catch (e) {} };
  AP.setVol(v, m); show();
  el.addEventListener('input', () => { AP.setVol(el.value / 100, false); show(); save(); });
  mb.addEventListener('click', () => { AP.setVol(null, !AP.muted); show(); save(); });
}

/* ---------------- project persistence ---------------- */
function mergeProject(p) {
  const d = J.defaultProject();
  if (J.isMobile && J.isMobile() && (!p || !p.res)) {
    d.res = 720;
    d.aspect = '9:16';
  }
  const o = Object.assign(d, p || {});
  o.fx = Object.assign(J.defaultProject().fx, (p && p.fx) || {});
  o.timing = Object.assign(J.defaultProject().timing, (p && p.timing) || {});
  const en = J.defaultProject().enabled;
  for (const g of Object.keys(en)) en[g] = Object.assign(en[g], ((p && p.enabled) || {})[g] || {});
  o.enabled = en;
  o.overrides = (p && p.overrides) || {};
  o.colors = Object.assign({ enabled: false }, (p && p.colors) || {});
  o.fonts = (p && p.fonts) || {};
  o.userFonts = (p && p.userFonts) || [];
  for (const uf of o.userFonts) if (!J.FONTS[uf.key]) J.addUserFont(uf.key, uf.label, uf.family, uf.weight || 400);
  return o;
}
function setBadges(d) {
  return (d && d.extra ? '<span class="set-badge ex" title="最初の公開版のあとに追加">追加</span>' : '') + (d && d.wa ? '<span class="set-badge" title="和風の演出">和</span>' : '');
}
function loadLocal() { try { const s = localStorage.getItem(LS_KEY); if (s) return mergeProject(JSON.parse(s)); } catch (e) {} return mergeProject(null); }
let saveTimer = 0;
function autosave() { clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 700); }
function flushSave() { clearTimeout(saveTimer); try { localStorage.setItem(LS_KEY, JSON.stringify(S.project)); } catch (e) {} }
window.addEventListener('pagehide', () => { if (S.project) flushSave(); });

/* ---------------- planning ---------------- */
function audioLike() {
  const T = S.project.timing;
  if (S.audio) {
    const a = Object.assign({}, S.audio);
    if (T.bpm > 0) a.beats = J.beatGrid(T.bpm, T.beatOffset || 0, S.audio.duration);
    return a;
  }
  if (T.bpm > 0) return { beats: J.beatGrid(T.bpm, T.beatOffset || 0, 600) };
  return null;
}
/* 自動判定のとき、判定結果を言語欄の横に出す */
function langNote() {
  const el = $('langNote'); if (!el) return;
  el.textContent = (S.project.lang || 'auto') === 'auto' ? '→ ' + J.LANG_LABEL[J.resolveLang(S.project)] : '';
  if (langNote.last !== undefined && langNote.last !== J.lang) { try { renderFontRoles(); } catch (e) {} }   // font menus show the language's faces
  langNote.last = J.lang;
}
function replan() {
  S.plan = J.plan(S.project, audioLike());
  langNote();
  if (S.t > S.plan.duration) S.t = 0;
  renderLines(); sizeViewport(); drawTimeline(); updateTimeUI();
  S.need = true; autosave(); ensureFonts(); drawSwatch(); showNow();
  clearTimeout(warmTimer); warmTimer = setTimeout(warm, 450);
}
/* pre-decompose glyphs used by piece animations while the editor is idle, so playback does not hitch */
let warmTimer = 0, warmJob = 0;
function warm() {
  const job = ++warmJob;
  const cuts = S.plan.cuts.filter(c => c.enter === 'assemble' || ['explode', 'fall', 'drift'].includes(c.exit));
  const src = $('view');
  const cv = document.createElement('canvas'); cv.width = src.width; cv.height = src.height;
  const ctx = cv.getContext('2d');
  let i = 0;
  const idle = window.requestIdleCallback ? (f) => window.requestIdleCallback(f, { timeout: 400 }) : (f) => setTimeout(() => f(null), 40);
  const step = (deadline) => {
    if (job !== warmJob || S.exporting) return;
    do {
      const c = cuts[i++]; if (!c) break;
      const ts = [];
      if (c.enter === 'assemble') ts.push(c.start + Math.min(c.inDur * 0.3, c.dur * 0.2));
      if (c.outDur > 0) ts.push(c.end - c.outDur * 0.5);
      for (const t of ts) { try { S.renderer.frame(ctx, S.plan, t, { scale: cv.width / S.plan.W, fast: true, noHud: true, noGhost: true }); } catch (e) {} }
    } while (i < cuts.length && deadline && deadline.timeRemaining() > 10);
    if (i < cuts.length) idle(step);
  };
  idle(step);
}
let replanTimer = 0;
const replanSoon = (ms = 220) => { clearTimeout(replanTimer); replanTimer = setTimeout(replan, ms); };
let fontKey = '';
let thumbFonts = null;
async function ensureFonts() {
  const txt = S.project.lyrics + (S.project.title || '') + (S.project.artist || '') + HUD_CHARS;
  const keys = J.fontsOfPlan(S.plan);                       // only the faces this plan draws with
  const key = txt + '|' + keys.join(',') + '|' + Object.keys(J.FONTS).length;
  if (key === fontKey) return;
  fontKey = key;
  showMsg('フォントを読み込み中…');
  try { await J.ensureFonts(txt, keys); } catch (e) {}
  showMsg(null); S.need = true; drawStyleGrid(); loadThumbFonts();
}
// style thumbnails need two glyphs of every style's display face — fetched only once the style grid is actually shown
function loadThumbFonts() {
  if (thumbFonts || !$('styleGrid').offsetParent) return;
  thumbFonts = J.ensureFonts('字面', [...new Set(J.STYLE_ORDER.map(k => J.STYLES[k].fonts.display[0]))]).then(() => drawStyleGrid()).catch(() => {});
}
function showMsg(m) { const el = $('viewMsg'); if (!m) { el.hidden = true; return; } el.textContent = m; el.hidden = false; }

/* ---------------- viewport & drawing ---------------- */
function sizeViewport() {
  const vp = $('viewport'), c = $('view');
  const ar = S.plan.W / S.plan.H;
  let cssW = vp.clientWidth || 800, cssH = cssW / ar;
  const maxH = Math.max(220, window.innerHeight * 0.68);
  if (cssH > maxH) { cssH = maxH; cssW = cssH * ar; }
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pw = Math.round(Math.min(S.plan.W, cssW * dpr)), ph = Math.round(pw / ar);
  if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
  
  // No longer forcefully setting inline style width/height 
  // Let the CSS flexbox and aspect-ratio handle the container size.
  // We just let the canvas fit naturally within the .viewport container
  c.style.width = '100%';
  c.style.height = '100%';
  S.need = true;
}
function draw() {
  const c = $('view'), ctx = c.getContext('2d');
  const t0 = performance.now();
  const hasBg = !!S.bgImageUrl;
  S.renderer.frame(ctx, S.plan, S.t, { scale: c.width / S.plan.W, fast: S.playing && S.slow, transparent: hasBg });
  const dt = performance.now() - t0;
  S.slow = S.playing ? (dt > 30 ? true : dt < 14 ? false : S.slow) : false;
  updateTimeUI(); drawTimeline(); updateCutInfo();
}
function tick(now) {
  requestAnimationFrame(tick);
  if (S.exporting) return;
  if (S.playing) {
    // rAF timestamps can precede the moment play()/seek() stamped t0 → clamp so t never goes negative
    let t = Math.max(0, S.audio ? AP.time() : (now - S.t0) / 1000);
    if (t >= S.plan.duration - 1e-3) {
      if (S.loop && !S.tap) { seek(0); t = 0; }
      else { pause(); t = S.plan.duration - 1e-3; if (S.tap) stopTap(); }
    }
    S.t = t; S.need = true;
  }
  if (S.need) { S.need = false; draw(); }
}
function updateTimeUI() {
  $('timeNow').textContent = J.fmtTime(S.t);
  $('timeDur').textContent = J.fmtTime(S.plan.duration);
  if (!S.scrubbing) $('scrub').value = String(Math.round(S.t / Math.max(0.001, S.plan.duration) * 10000));
}
function play() {
  if (S.audio) AP.play(S.audio.buffer, S.t);
  else S.t0 = performance.now() - S.t * 1000;
  S.playing = true; $('btnPlay').textContent = '❚❚'; $('btnPlay').setAttribute('aria-label', '一時停止');
}
function pause() {
  S.playing = false; AP.stop();
  $('btnPlay').textContent = '▶'; $('btnPlay').setAttribute('aria-label', '再生'); S.need = true;
}
function seek(t) {
  S.t = J.clamp(t, 0, Math.max(0, S.plan.duration - 1e-3));
  if (S.audio) { if (S.playing) AP.play(S.audio.buffer, S.t); }
  else S.t0 = performance.now() - S.t * 1000;
  S.need = true;
}
window._seek = seek;  // expose for timeline module

/* ---------------- timeline ---------------- */
const layoutHue = k => (J.LAYOUT_ORDER.indexOf(k) * 37 + 30) % 360;
function drawTimeline() {
  const c = $('timeline'), dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(10, Math.round(c.clientWidth * dpr)), h = Math.max(10, Math.round(c.clientHeight * dpr));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const x = c.getContext('2d'), D = Math.max(0.001, S.plan.duration), X = t => t / D * w;
  x.fillStyle = '#131316'; x.fillRect(0, 0, w, h);
  if (S.audio && S.audio.peaks) {
    const pk = S.audio.peaks, n = pk.length, sd = S.audio.duration;
    x.fillStyle = '#2b2b33';
    for (let i = 0; i < w; i += 2) { const t = i / w * D; if (t > sd) break; const v = pk[Math.min(n - 1, Math.floor(t / sd * n))]; const hh = v * h * 0.8; x.fillRect(i, h * 0.6 - hh / 2, 1.5, hh); }
  }
  const beats = S.plan.beats || [];
  x.fillStyle = '#3a3a44';
  for (const b of beats) { if (b > D) break; x.fillRect(Math.round(X(b)), h - 6 * dpr, 1, 6 * dpr); }
  const top = h * 0.3, bot = h - 8 * dpr;
  for (const cut of S.plan.cuts) {
    const x0 = X(cut.start), x1 = X(cut.end);
    const hue = layoutHue(cut.layout);
    x.fillStyle = `hsla(${hue},70%,58%,0.28)`; x.fillRect(x0, top, Math.max(1, x1 - x0 - 1), bot - top);
    x.fillStyle = `hsla(${hue},80%,62%,0.95)`; x.fillRect(x0, top, Math.max(1, 2 * dpr), bot - top);
    if (x1 - x0 > 34 * dpr) {
      x.fillStyle = 'rgba(236,231,225,0.85)'; x.font = `${10 * dpr}px ${getComputedStyle(document.body).getPropertyValue('--mono') || 'monospace'}`;
      x.save(); x.beginPath(); x.rect(x0, top, x1 - x0 - 3, bot - top); x.clip();
      x.fillText((J.LAYOUTS[cut.layout] || {}).name || cut.layout, x0 + 5 * dpr, top + 13 * dpr); x.restore();
    }
  }
  x.font = `${10 * dpr}px monospace`;
  for (const ln of S.plan.lines) {
    const lx = X(ln.start);
    x.fillStyle = '#5d5a63'; x.fillRect(lx, 0, 1, top);
    x.fillStyle = '#8e8a94'; x.fillText(String(ln.index + 1).padStart(2, '0'), lx + 3 * dpr, 12 * dpr);
  }
  const px = X(S.t);
  x.fillStyle = '#f5a50c'; x.fillRect(Math.round(px) - dpr, 0, 2 * dpr, h);
}
function timelineSeek(ev) {
  const r = $('timeline').getBoundingClientRect();
  seek((ev.clientX - r.left) / r.width * S.plan.duration);
}

/* ---------------- cut info ---------------- */
let lastCutIdx = -2;
function updateCutInfo() {
  const cut = J.cutAt(S.plan, S.t);
  const idx = cut ? cut.index : -1;
  const li = cut ? cut.line : -1;
  if (li !== S.curLine) { S.lineEls.forEach((el, i) => el.classList.toggle('cur', i === li)); S.curLine = li; }
  if (idx === lastCutIdx) return;
  lastCutIdx = idx;
  const el = $('cutInfo');
  if (!cut) { el.innerHTML = '<span class="hint">この位置にカットはありません</span>'; return; }
  const chip = (cls, k, v) => `<span class="chip ${cls}"><b>${k}</b>${v}</span>`;
  const n = (tbl, k) => (tbl[k] ? tbl[k].name : k);
  el.innerHTML = [
    `<span class="chip mono">#${String(cut.index + 1).padStart(2, '0')}</span>`,
    chip('l', 'レイアウト', n(J.LAYOUTS, cut.layout)), chip('e', '登場', n(J.ENTER, cut.enter)), chip('h', '保持', n(J.HOLD, cut.hold)), chip('x', '退場', n(J.EXIT, cut.exit)),
    cut.decor && cut.decor.length ? chip('', '装飾', cut.decor.map(d => n(J.DECOR, d.id)).join('・')) : '',
    cut.treat && cut.treat !== 'none' ? chip('t', '加工', n(J.TREAT, cut.treat)) : '',
    cut.bg && cut.bg !== 'none' ? chip('b', '背景', n(J.BG, cut.bg)) : '',
    cut.cam && cut.cam !== 'push' ? chip('c', 'カメラ', n(J.CAMERA, cut.cam)) : '',
    cut.trans ? chip('c', 'つなぎ', n(J.TRANS, cut.trans)) : '',
  ].join('');
}

/* ---------------- line list ---------------- */
function renderLines() {
  const ol = $('lineList'); ol.innerHTML = ''; S.lineEls = []; S.curLine = -2;
  const ov = S.project.overrides;
  const layoutOpts = '<option value="">自動</option>' + J.LAYOUT_ORDER.map(k => `<option value="${k}">${J.LAYOUTS[k].name}</option>`).join('');
  S.plan.lines.forEach((ln, i) => {
    const o = ov[i] || {};
    const li = document.createElement('li'); li.className = 'ln';
    const manual = S.project.timing.lineTimes && S.project.timing.lineTimes[i] != null;
    li.innerHTML = `<span class="no">${String(i + 1).padStart(2, '0')}</span>
      <input class="time mono" type="number" step="0.01" min="0" value="${ln.start.toFixed(2)}" title="開始（秒）${manual ? '・手動' : '・自動'}" aria-label="${i + 1}行目の開始秒" style="${manual ? 'border-color:var(--cyan)' : ''}">
      <span class="txt" title="${escapeHtml(ln.text)}">${escapeHtml(ln.text)}</span>
      <div class="meta"><span class="cuts"></span>
      <span class="tools">
        <select aria-label="レイアウト指定">${layoutOpts}</select>
        <button class="icon ghost dice" title="この行を再抽選">${ICON.dice}</button>
        <button class="icon ghost lock" title="この行の構成をロック" aria-pressed="${o.lock ? 'true' : 'false'}">${ICON.lock}</button>
      </span></div>`;
    li.querySelector('select').value = o.layout || '';
    li.querySelector('.time').addEventListener('change', e => {
      const v = parseFloat(e.target.value);
      if (!S.project.timing.lineTimes) S.project.timing.lineTimes = {};
      if (isFinite(v)) S.project.timing.lineTimes[i] = Math.max(0, v); else delete S.project.timing.lineTimes[i];
      replan();
    });
    li.querySelector('.txt').addEventListener('click', () => seek(ln.start + 0.001));
    li.querySelector('select').addEventListener('change', e => { setOv(i, { layout: e.target.value || undefined }); replan(); });
    li.querySelector('.dice').addEventListener('click', () => { const cur = ov[i] || {}; setOv(i, { seed: (cur.seed | 0) + 1, lock: false }); replan(); seek(ln.start + 0.001); });
    li.querySelector('.lock').addEventListener('click', () => {
      const cur = ov[i] || {};
      if (cur.lock) setOv(i, { lock: false, lockedSeed: undefined });
      else setOv(i, { lock: true, lockedSeed: ln.seed });
      replan();
    });
    const cutsEl = li.querySelector('.cuts');
    S.plan.cuts.filter(c => c.line === i && J.LAYOUTS[c.layout] && !J.LAYOUTS[c.layout].special).forEach(c => {
      const sp = document.createElement('span'); sp.textContent = J.LAYOUTS[c.layout].name; sp.title = `${c.text}｜${J.ENTER[c.enter].name} → ${J.EXIT[c.exit].name}`;
      sp.style.borderColor = `hsla(${layoutHue(c.layout)},70%,58%,0.7)`;
      sp.addEventListener('click', () => seek(c.start + Math.min(c.dur * 0.5, c.inDur + 0.05)));
      cutsEl.appendChild(sp);
    });
    ol.appendChild(li); S.lineEls.push(li);
  });
  $('linesInfo').textContent = `${S.plan.lines.length}行 / ${S.plan.cuts.length}カット`;
}
function setOv(i, patch) {
  const cur = Object.assign({}, S.project.overrides[i] || {}, patch);
  for (const k of Object.keys(cur)) if (cur[k] === undefined || cur[k] === false || cur[k] === '') delete cur[k];
  if (Object.keys(cur).length) S.project.overrides[i] = cur; else delete S.project.overrides[i];
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* ---------------- style tab ---------------- */
function drawStyleGrid() {
  const g = $('styleGrid');
  if (!g.children.length) {
    J.STYLE_ORDER.forEach(k => {
      const b = document.createElement('button'); b.className = 'stile'; b.dataset.k = k;
      b.title = J.STYLES[k].desc;
      b.innerHTML = `<canvas width="192" height="108"></canvas><span>${J.STYLES[k].name}</span><span class="badges">${setBadges(J.STYLES[k])}</span>`;
      b.addEventListener('click', () => { remember(); S.project.style = k; S.project.colors.enabled = false; syncUI(); replan(); commit(); });
      g.appendChild(b);
    });
  }
  [...g.children].forEach(b => {
    const k = b.dataset.k, st = J.STYLES[k], sc = st.schemes[0], cv = b.querySelector('canvas'), x = cv.getContext('2d');
    b.setAttribute('aria-pressed', S.project.style === k ? 'true' : 'false');
    const off = !J.randomOk(S.project, 'style', k);
    b.classList.toggle('set-off', off);
    b.title = st.desc + (off ? (st.extra && S.project.extra !== true ? '（追加分がオフのため、おまかせでは選ばれません）' : '（和風の演出がオフのため、おまかせでは選ばれません）') : '');
    x.fillStyle = sc.bg; x.fillRect(0, 0, 192, 108);
    st.schemes.slice(1, 4).forEach((s2, i) => { x.fillStyle = s2.bg; x.fillRect(192 - 14 * (i + 1), 0, 14, 10); });
    const f = st.fonts.display[0];
    x.font = J.fontCSS(f, 46); x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillStyle = sc.ghostB; x.fillText('字面', 96 - 3, 54 - 1);
    x.fillStyle = sc.ghostA; x.fillText('字面', 96 + 3, 54 + 2);
    x.fillStyle = sc.fg; x.fillText('字面', 96, 54);
    x.fillStyle = sc.accent; x.fillRect(12, 90, 30, 4);
    x.font = J.fontCSS('mono', 9); x.textAlign = 'left'; x.fillStyle = sc.sub; x.fillText(k.toUpperCase(), 48, 93);
  });
}
function fontSelectOptions(sel) {
  return '<option value="">スタイルの既定</option>' + Object.entries(J.FONTS).map(([k, f]) => {
    const g = J.faceOf ? J.faceOf(k) : f, alt = g.label && g.label !== f.label ? ' → ' + g.label : '';   // the face actually used for the lyric language
    return `<option value="${k}" ${sel === k ? 'selected' : ''}>${escapeHtml(f.label + alt)}</option>`;
  }).join('');
}
function renderFontRoles() {
  const box = $('fontRoles'); box.innerHTML = '';
  [['display', '見出し'], ['serif', '明朝枠'], ['body', '小さな文字']].forEach(([role, label]) => {
    const row = document.createElement('div'); row.className = 'font-row';
    row.innerHTML = `<span class="muted">${label}</span><select aria-label="${label}のフォント">${fontSelectOptions(S.project.fonts[role])}</select>`;
    row.querySelector('select').addEventListener('change', e => { if (e.target.value) S.project.fonts[role] = e.target.value; else delete S.project.fonts[role]; fontKey = ''; replan(); });
    box.appendChild(row);
  });
}
const BASE_KEYS = [['bg', '背景'], ['fg', '文字'], ['sub', '補助']];
const ACCENT_KEYS = [['accent', 'アクセント'], ['ghostA', 'ズレ色A'], ['ghostB', 'ズレ色B']];
function renderColors() {
  const st = J.STYLES[S.project.style] || J.STYLES.noir, sc = st.schemes[0];
  const c = S.project.colors;
  $('colorOn').checked = !!c.enabled;
  $('accentOn').checked = !!c.accentOn;
  const fill = (rowId, keys, flag) => {
    const row = $(rowId); row.innerHTML = '';
    keys.forEach(([k, label]) => {
      const l = document.createElement('label');
      const v = (c[flag] && c[k]) || c[k] || sc[k];
      l.innerHTML = `${label}<input type="color" value="${toColorInput(v)}">`;
      l.querySelector('input').addEventListener('input', e => {
        c[k] = e.target.value.toUpperCase();
        if (!c[flag]) { c[flag] = true; $(flag === 'enabled' ? 'colorOn' : 'accentOn').checked = true; }
        replanSoon(60); drawSwatch();
      });
      row.appendChild(l);
    });
  };
  fill('colorRow', BASE_KEYS, 'enabled');
  fill('colorRowAccent', ACCENT_KEYS, 'accentOn');
  drawSwatch();
}
const toColorInput = v => { const h = String(v || '#000000'); return /^#[0-9a-f]{6}$/i.test(h) ? h.toLowerCase() : J.toHex(...J.hex(h)).toLowerCase(); };
function swatchHTML(cols) { return cols.map(c => `<i style="background:${c}" title="${c}"></i>`).join(''); }
function drawSwatch() {
  const sc = S.plan ? S.plan.style.schemes[0] : null; if (!sc) return;
  $('paletteSwatch').innerHTML = swatchHTML([sc.accent, sc.ghostA, sc.ghostB]);
}
function randomPalette() {
  remember();
  const c = S.project.colors;
  const sc0 = J.STYLES[S.project.style].schemes[0];
  const bg = c.enabled && c.bg ? c.bg : sc0.bg;
  let p, guard = 0;
  do { p = J.randomPalette(bg); } while (guard++ < 6 && p.ghostA === c.ghostA && p.ghostB === c.ghostB);
  Object.assign(c, { accent: p.accent, ghostA: p.ghostA, ghostB: p.ghostB, accentOn: true });
  renderColors(); replan(); commit();
  toast('配色：アクセント・ズレ色A/Bを変更', [p.accent, p.ghostA, p.ghostB]);
}

/* ---------------- history of looks (◀ ▶) ---------------- */
// only the "look" is tracked — lyrics, timing and output settings are never rolled back
const HKEYS = ['style', 'mood', 'seed', 'fx', 'enabled', 'fonts', 'colors', 'overrides'];
const H = { list: [], i: -1 };
const lookSnap = () => JSON.stringify(Object.fromEntries(HKEYS.map(k => [k, S.project[k] ?? null])));
function remember() {            // call before changing the look: makes sure the current look is on the stack
  const s = lookSnap();
  if (H.i >= 0 && H.list[H.i] === s) return;
  H.list = H.list.slice(0, H.i + 1); H.list.push(s); H.i = H.list.length - 1;
}
function commit() {              // call after changing the look
  const s = lookSnap();
  if (H.list[H.i] !== s) { H.list = H.list.slice(0, H.i + 1); H.list.push(s); H.i = H.list.length - 1; }
  if (H.list.length > 80) { H.list.splice(0, H.list.length - 80); H.i = H.list.length - 1; }
  updateHist();
}
function histGo(d) {
  if (S.exporting) return;
  remember();                    // hand edits made since the last step become a stop of their own
  const j = H.i + d; if (j < 0 || j >= H.list.length) return;
  H.i = j;
  Object.assign(S.project, JSON.parse(H.list[j]));
  fontKey = ''; syncUI(); replan(); updateHist();
  toast(`${j + 1} / ${H.list.length} 案目`);
  restartPreview();
}
function updateHist() {
  const canB = H.i > 0, canF = H.i < H.list.length - 1;
  ['btnPrev', 'btnPrev2'].forEach(id => { $(id).disabled = !canB; });
  ['btnNext', 'btnNext2'].forEach(id => { $(id).disabled = !canF; });
  $('histPos').textContent = H.list.length > 1 ? `${H.i + 1} / ${H.list.length}` : '';
}

/* ---------------- おまかせ & ジャンル別プリセット ---------------- */
let currentGenre = 'auto';

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const GENRE_PRESETS = {
  auto: {
    name: 'おまかせ',
    hint: '全ジャンルからランダム',
    apply: () => J.omakase(S.project)
  },
  ballad: {
    name: 'バラード',
    hint: '明朝体 × 静かなフェード・ブラー演出',
    apply: () => {
      const r = J.omakase(S.project);
      r.mood = 'calm';
      r.fonts = Object.assign({}, r.fonts, {
        display: pickRandom(['shippori', 'mincho_black', 'tokumin']),
        serif: 'mincho_bold'
      });
      r.style = pickRandom(['paper', 'specimen', 'noir', 'mono']);
      r.fx = Object.assign({}, r.fx, {
        motion: +(0.25 + Math.random() * 0.15).toFixed(2),
        glitch: 0.05,
        chroma: 0.2,
        texture: 0.7
      });
      return r;
    }
  },
  pop: {
    name: 'ポップ',
    hint: 'ポップ体/丸文字 × 弾むバウンス・明るい演出',
    apply: () => {
      const r = J.omakase(S.project);
      r.mood = 'pop';
      r.fonts = Object.assign({}, r.fonts, {
        display: pickRandom(['pop', 'round', 'kiwi']),
        serif: 'round'
      });
      r.style = pickRandom(['magenta', 'caution', 'transit', 'blueprint', 'rouge']);
      r.fx = Object.assign({}, r.fx, {
        motion: +(0.8 + Math.random() * 0.15).toFixed(2),
        glitch: 0.1,
        decor: 0.85
      });
      return r;
    }
  },
  rock: {
    name: 'ロック',
    hint: '極太ゴシック × 迫力スライド・画面の揺れ',
    apply: () => {
      const r = J.omakase(S.project);
      r.mood = pickRandom(['emotional', 'graphic']);
      r.fonts = Object.assign({}, r.fonts, {
        display: pickRandom(['dela', 'zenkaku', 'gothic_black']),
        serif: 'mincho_black'
      });
      r.style = pickRandom(['crimson', 'noir', 'blueprint', 'caution']);
      r.fx = Object.assign({}, r.fx, {
        motion: +(0.75 + Math.random() * 0.15).toFixed(2),
        glitch: 0.35,
        chroma: 0.6
      });
      return r;
    }
  },
  cyber: {
    name: 'サイバー',
    hint: '等幅/ピクセル文字 × グリッチ・電子的スライス',
    apply: () => {
      const r = J.omakase(S.project);
      r.mood = 'glitch';
      r.fonts = Object.assign({}, r.fonts, {
        display: pickRandom(['dot', 'mono']),
        serif: 'mono'
      });
      r.style = pickRandom(['hud', 'mint', 'noir', 'crimson']);
      r.fx = Object.assign({}, r.fx, {
        motion: +(0.7 + Math.random() * 0.2).toFixed(2),
        glitch: 0.85,
        chroma: 0.8
      });
      return r;
    }
  },
  chill: {
    name: 'チル',
    hint: 'モダンゴシック × 洗練されたタイポグラフィ',
    apply: () => {
      const r = J.omakase(S.project);
      r.mood = 'editorial';
      r.fonts = Object.assign({}, r.fonts, {
        display: pickRandom(['sansui', 'gothic_med']),
        serif: 'mincho'
      });
      r.style = pickRandom(['specimen', 'mono', 'paper', 'noir']);
      r.fx = Object.assign({}, r.fx, {
        motion: +(0.35 + Math.random() * 0.15).toFixed(2),
        glitch: 0.1,
        chroma: 0.25
      });
      return r;
    }
  },
  wa: {
    name: '和風',
    hint: '筆文字風 × 縦書き・和の情緒的演出',
    apply: () => {
      const r = J.omakase(S.project);
      r.mood = pickRandom(['calm', 'emotional']);
      r.fonts = Object.assign({}, r.fonts, {
        display: pickRandom(['brush', 'tokumin', 'shippori']),
        serif: 'brush'
      });
      r.style = pickRandom(['paper', 'crimson', 'noir']);
      r.fx = Object.assign({}, r.fx, {
        motion: +(0.4 + Math.random() * 0.2).toFixed(2),
        decor: 0.7
      });
      return r;
    }
  }
};

function applyGenre(g) {
  if (S.exporting || S.tap) return;
  remember();
  const preset = GENRE_PRESETS[g] || GENRE_PRESETS.auto;
  const r = preset.apply();
  if (currentColorTone && currentColorTone !== 'auto') r.colorTone = currentColorTone;
  Object.assign(S.project, r);
  fontKey = ''; syncUI(); replan(); commit();
  const genreLabel = g === 'auto' ? 'おまかせ' : preset.name;
  const toneLabel = (r.colorTone && r.colorTone !== 'auto' && J.COLOR_TONES[r.colorTone]) ? ` (${J.COLOR_TONES[r.colorTone].name})` : '';
  toast(`${genreLabel}：${J.STYLES[r.style].name} × ${J.MOODS[r.mood].name}${toneLabel}`, r.colors.accentOn ? [r.colors.accent, r.colors.ghostA, r.colors.ghostB] : null);
  restartPreview();
}

let currentColorTone = 'auto';

function applyColorToneUI(tone) {
  if (S.exporting || S.tap) return;
  remember();
  currentColorTone = tone;
  S.project.colorTone = tone;
  syncUI(); replan(); commit();
  const label = tone === 'auto' ? 'おまかせ（標準配色）' : (J.COLOR_TONES[tone] ? J.COLOR_TONES[tone].name : tone);
  toast(`文字色：${label}に設定`);
  S.need = true; draw();
}

function initColorToneSelector() {
  const container = document.getElementById('colorToneList');
  if (!container) return;
  const hintEl = document.getElementById('colorToneHint');
  container.querySelectorAll('.amuvi-genre-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const tone = btn.dataset.tone;
      if (!tone) return;
      currentColorTone = tone;
      container.querySelectorAll('.amuvi-genre-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (hintEl) {
        hintEl.textContent = tone === 'auto' ? 'スタイルの標準配色' : (J.COLOR_TONES[tone] ? J.COLOR_TONES[tone].hint : '');
      }
      applyColorToneUI(tone);
    });
  });
}

/* ---------------- depth controls (lyrics pass behind character) ---------------- */
function updateAvoidMarkerUI() {}
function initAvoidArea() {}

function updateDepthUI() {
  const controls = document.getElementById('charDepthControls');
  const btnDetect = document.getElementById('btnDetectChar');
  const hasChar = !!window._charFgImgObj || (J.depth && J.depth.ready(window._bgImgObj));
  if (!controls) return;
  if (!hasChar) {
    controls.style.display = 'none';
    if (btnDetect) { btnDetect.disabled = false; btnDetect.textContent = '🤖 背景からキャラ切り抜き'; }
    return;
  }
  controls.style.display = 'flex';
  if (btnDetect) {
    btnDetect.disabled = false;
    btnDetect.textContent = (J.depth && J.depth.ready(window._bgImgObj)) ? '✓ AI切り抜き済み' : '🤖 背景からキャラ切り抜き';
  }
  const currentDepth = S.project.depth || 'behind';
  controls.querySelectorAll('.amuvi-depth-chip').forEach(chip => {
    chip.classList.toggle('active', chip.dataset.depth === currentDepth);
  });
}

function initDepthControls() {
  const btnDetect = document.getElementById('btnDetectChar');
  const progressBox = document.getElementById('charDetectProgress');
  const statusEl = document.getElementById('charDetectStatus');
  const percentEl = document.getElementById('charDetectPercent');
  const barEl = document.getElementById('charDetectBar');
  const controls = document.getElementById('charDepthControls');

  if (btnDetect) {
    btnDetect.addEventListener('click', async () => {
      const img = window._bgImgObj;
      if (!img || !img.src) {
        toast('先に背景画像を読み込んでください');
        return;
      }
      if (J.depth && J.depth.busy) return;
      btnDetect.disabled = true;
      btnDetect.textContent = '検出中…';
      if (progressBox) progressBox.style.display = 'flex';
      if (controls) controls.style.display = 'none';

      try {
        await J.depth.detect(img, (phase, pct) => {
          let text = '処理中…';
          let pVal = Math.round(pct * 100);
          if (phase === 'engine') text = 'AIエンジン準備中…';
          else if (phase === 'model') text = `AIモデル取得中… ${pVal}%（初回のみ保存）`;
          else if (phase === 'init') text = 'AI推論セッション初期化…';
          else if (phase === 'run') { text = 'キャラクターを切り抜き中…'; pVal = 92; }
          else if (phase === 'done') { text = '完了！'; pVal = 100; }
          if (statusEl) statusEl.textContent = text;
          if (percentEl) percentEl.textContent = `${pVal}%`;
          if (barEl) barEl.style.width = `${pVal}%`;
        });

        if (progressBox) progressBox.style.display = 'none';
        S.project.depth = 'behind';

        updateDepthUI();
        replan(); commit(); S.need = true; draw();
        toast('🤖 キャラを検出しました！リリックが背後を通過します');
      } catch (err) {
        console.error('char detect err', err);
        if (progressBox) progressBox.style.display = 'none';
        btnDetect.disabled = false;
        btnDetect.textContent = '🤖 背景からキャラ切り抜き';
        toast(`検出エラー: ${err.message || err}`);
      }
    });
  }

  if (controls) {
    controls.querySelectorAll('.amuvi-depth-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const mode = chip.dataset.depth;
        S.project.depth = mode;
        updateDepthUI();
        replan(); commit(); S.need = true; draw();
        const labels = {
          behind: '🎭 キャラの背後を通る（奥レイヤー）',
          cross: '⚡ 手前・奥が交差（3D立体）',
          off: '通常表示（前面）'
        };
        toast(labels[mode] || mode);
      });
    });
  }
}

function initGenreSelector() {
  const container = document.getElementById('genreList');
  if (!container) return;
  const hintEl = document.getElementById('genreHint');
  container.querySelectorAll('.amuvi-genre-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const g = btn.dataset.genre;
      if (!GENRE_PRESETS[g]) return;
      currentGenre = g;
      container.querySelectorAll('.amuvi-genre-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (hintEl) hintEl.textContent = GENRE_PRESETS[g].hint;
      applyGenre(g);
    });
  });
}

function restartPreview() { seek(0); if (!S.playing && S.mode === 'easy') play(); }
function omakase() {
  if (S.exporting || S.tap) return;
  remember();
  const preset = GENRE_PRESETS[currentGenre] || GENRE_PRESETS.auto;
  const r = preset.apply();
  if (currentColorTone && currentColorTone !== 'auto') r.colorTone = currentColorTone;
  Object.assign(S.project, r);
  fontKey = ''; syncUI(); replan(); commit();
  const genreLabel = currentGenre === 'auto' ? 'おまかせ' : preset.name;
  const toneLabel = (r.colorTone && r.colorTone !== 'auto' && J.COLOR_TONES[r.colorTone]) ? ` (${J.COLOR_TONES[r.colorTone].name})` : '';
  toast(`${genreLabel}：${J.STYLES[r.style].name} × ${J.MOODS[r.mood].name}${toneLabel}`, r.colors.accentOn ? [r.colors.accent, r.colors.ghostA, r.colors.ghostB] : null);
  restartPreview();
}
// change just one aspect of the current look
function rerollPart(part) {
  if (S.exporting || S.tap) return;
  remember();
  const P = S.project;
  let msg = '';
  if (part === 'style') {
    let pool = J.STYLE_ORDER.filter(k => k !== P.style && J.randomOk(P, 'style', k));
    if (!pool.length) pool = J.STYLE_ORDER.filter(k => k !== P.style);
    P.style = pool[Math.floor(Math.random() * pool.length)];
    P.colors.enabled = false;
    msg = `スタイル：${J.STYLES[P.style].name}`;
  } else if (part === 'mood') {
    const r = J.omakase(P);
    Object.assign(P, { mood: r.mood, fx: r.fx, enabled: r.enabled });
    msg = `雰囲気：${J.MOODS[r.mood].name}`;
  } else if (part === 'cut') {
    P.seed = (Math.random() * 1e9) | 0;
    msg = '構成：レイアウトと動きを再抽選';
  }
  fontKey = ''; syncUI(); replan(); commit();
  toast(msg);
  restartPreview();
}
function showNow() {
  const el = $('easyNow'); if (!el || !S.plan || el.closest('[hidden]')) return;
  const P = S.project, sc = S.plan.style.schemes[0];
  const moodName = P.mood && J.MOODS[P.mood] ? J.MOODS[P.mood].name : 'カスタム';
  const fk = S.plan.style.fonts.display[0];
  const fontName = J.FONTS[fk] ? J.FONTS[fk].label : fk;
  const cuts = S.plan.cuts.filter(c => c.line >= 0 && c.layout !== 'interlude');
  const kinds = new Set(cuts.map(c => c.layout)).size;
  const row = (k, v) => `<div class="now-row"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  el.innerHTML = row('スタイル', `<b>${escapeHtml(J.STYLES[P.style].name)}</b>`)
    + row('雰囲気', escapeHtml(moodName))
    + row('配色', `<span class="swatches">${swatchHTML([sc.bg, sc.fg, sc.accent, sc.ghostA, sc.ghostB])}</span>${P.colors.accentOn ? '<span class="tagl">ランダム</span>' : ''}`)
    + row('見出し書体', escapeHtml(fontName))
    + row('構成', `${cuts.length} カット・レイアウト ${kinds} 種`)
    + row('演出', `加工 ${cuts.filter(c => c.treat && c.treat !== 'none').length}・背景 ${new Set(cuts.map(c => c.bg).filter(b => b && b !== 'none')).size}種・カメラ ${cuts.filter(c => c.cam && c.cam !== 'push').length}`);
}
let toastTimer = 0;
function toast(m, cols) {
  const el = $('toast'); if (!el) return;
  el.innerHTML = escapeHtml(m) + (cols ? `<span class="swatches">${swatchHTML(cols)}</span>` : '');
  el.hidden = false; el.classList.remove('out'); void el.offsetWidth; el.classList.add('in');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('in'); el.classList.add('out'); toastTimer = setTimeout(() => { el.hidden = true; }, 260); }, 1700);
}

/* ---------------- かんたん / 詳細 ---------------- */
function setMode(m) {
  S.mode = m === 'easy' ? 'easy' : 'pro';
  const easy = S.mode === 'easy';
  $('app').classList.toggle('is-easy', easy);
  $('easyPanel').hidden = !easy;
  $('modeEasy').setAttribute('aria-pressed', String(easy));
  $('modePro').setAttribute('aria-pressed', String(!easy));
  try { localStorage.setItem('jizura.mode', S.mode); } catch (e) {}
  if (easy) { showNow(); syncOut(); codecNote(); }
  sizeViewport(); drawTimeline(); loadThumbFonts();
}

/* ---------------- fx tab ---------------- */
const FX = [['motion', '動きの強さ'], ['glitch', 'グリッチ'], ['chroma', '色ズレ'], ['decor', '装飾の量'], ['density', 'カットの細かさ'], ['texture', '質感'], ['bgSwitch', '背景の切替']];
function renderFx() {
  const box = $('fxSliders'); box.innerHTML = '';
  FX.forEach(([k, label]) => {
    const row = document.createElement('div'); row.className = 'slider';
    const v = S.project.fx[k] ?? 0.5;
    row.innerHTML = `<label for="fx_${k}">${label}</label><input id="fx_${k}" type="range" min="0" max="1" step="0.01" value="${v}"><output>${Math.round(v * 100)}</output>`;
    const inp = row.querySelector('input'), out = row.querySelector('output');
    inp.addEventListener('input', () => { S.project.fx[k] = +inp.value; S.project.mood = null; out.textContent = Math.round(inp.value * 100); replanSoon(120); });
    box.appendChild(row);
  });
  $('fxFlash').checked = !!S.project.fx.flash;
  $('fxKoma').value = String(J.komaOf(S.project.fx));
  $('fxHud').value = S.project.fx.hud || 'auto';
  $('seed').value = S.project.seed;
}

/* ---------------- technique tab ---------------- */
const GROUPS = [['layout', 'レイアウト'], ['enter', '登場'], ['hold', '保持'], ['exit', '退場'], ['decor', '装飾'], ['treat', '文字の加工'], ['bg', '背景'], ['cam', 'カメラ'], ['fx', '画面効果'], ['trans', 'カット間のつなぎ']];
const openGroups = new Set();
function techItems(g) { return J.order(g).filter(k => J.registry(g)[k] && !J.registry(g)[k].special); }
function renderTech() {
  const box = $('techLists'); box.innerHTML = '';
  const q = ($('techFilter').value || '').trim().toLowerCase();
  let total = 0, onAll = 0;
  GROUPS.forEach(([g, label]) => {
    const tbl = J.registry(g), items = techItems(g), en = S.project.enabled[g] || (S.project.enabled[g] = {});
    const shown = q ? items.filter(k => (tbl[k].name + ' ' + k).toLowerCase().includes(q)) : items;
    const onN = items.filter(k => en[k] !== false).length;
    total += items.length; onAll += onN;
    if (q && !shown.length) return;
    const d = document.createElement('details'); d.className = 'tgroup';
    d.open = !!q || openGroups.has(g);
    d.addEventListener('toggle', () => { if (d.open) openGroups.add(g); else openGroups.delete(g); });
    d.innerHTML = `<summary><span class="tg-name">${label}</span><span class="tg-cnt mono">${onN}/${items.length}</span></summary><div class="tg-tools"><button class="ghost small" data-a="on">すべてON</button><button class="ghost small" data-a="off">すべてOFF</button><button class="ghost small" data-a="flip">反転</button></div>`;
    const list = document.createElement('div'); list.className = 'checks';
    shown.forEach(k => {
      const l = document.createElement('label');
      l.title = k + (tbl[k].tags && tbl[k].tags.length ? '（' + tbl[k].tags.map(t => (J.MOODS[t] ? J.MOODS[t].name : t)).join('・') + '）' : '');
      if (!J.randomOk(S.project, g, k)) { l.classList.add('set-off'); l.title += tbl[k].extra && S.project.extra !== true ? '（追加分がオフのため、自動では選ばれません）' : '（和風の演出がオフのため、自動では選ばれません）'; }
      l.innerHTML = `<input type="checkbox" ${en[k] !== false ? 'checked' : ''}> ${escapeHtml(tbl[k].name)}${setBadges(tbl[k])}`;
      l.querySelector('input').addEventListener('change', e => { en[k] = e.target.checked; S.project.mood = null; d.querySelector('.tg-cnt').textContent = `${items.filter(x => en[x] !== false).length}/${items.length}`; replanSoon(60); });
      list.appendChild(l);
    });
    d.querySelectorAll('.tg-tools button').forEach(b => b.addEventListener('click', () => {
      const a = b.dataset.a;
      shown.forEach(k => { en[k] = a === 'on' ? true : a === 'off' ? false : en[k] === false; });
      // keep a fallback so the planner always has something to use
      if (g === 'layout' && !items.some(k => en[k] !== false)) en.center = true;
      if (g === 'enter') en.cut = true; if (g === 'exit') en.cut = true; if (g === 'hold') en.still = true;
      if (g === 'treat') en.none = true; if (g === 'bg') en.none = true; if (g === 'cam') en.push = true;
      S.project.mood = null; openGroups.add(g); renderTech(); replan();
    }));
    d.appendChild(list);
    box.appendChild(d);
  });
  $('techTotal').textContent = `${onAll}/${total}`;
}

/* ---------------- output tab ---------------- */
function syncOut() {
  $('outAspect').value = S.project.aspect; $('outRes').value = String(S.project.res); $('outFps').value = String(S.project.fps);
  $('eAspect').value = S.project.aspect; $('eRes').value = String(S.project.res); $('eFps').value = String(S.project.fps);
  if ($('eMotionSmooth')) {
    if (S.project.motionSmooth) {
      $('eMotionSmooth').value = S.project.motionSmooth;
    } else if (S.project.fx && (S.project.fx.koma > 0 || S.project.fx.onTwos)) {
      $('eMotionSmooth').value = 'anime';
    } else if (S.project.fps >= 60) {
      $('eMotionSmooth').value = 'smooth60';
    } else if (S.project.fps >= 50) {
      $('eMotionSmooth').value = 'smooth50';
    } else if (S.project.fps >= 45) {
      $('eMotionSmooth').value = 'smooth45';
    } else {
      $('eMotionSmooth').value = 'smooth30';
    }
  }
  $('outQuality').value = S.project.quality || 'high';
  const incA = S.project.includeAudio !== false;
  $('outAudio').checked = incA;
  if ($('eAudio')) $('eAudio').checked = incA;
  const k = J.keyMode(S.project) || 'off';
  $('outKey').value = k; $('eKey').value = k;
  if ($('eBlackBackUI')) $('eBlackBackUI').checked = (k === 'black');
  const kb = $('keyBadge');
  kb.hidden = k === 'off';
  if (k !== 'off') kb.innerHTML = `<i style="background:${J.KEY_BG[k]}"></i>${k === 'green' ? 'グリーンバック' : 'ブラックバック'}`;

  const noteEl = $('eAudioNote');
  if (noteEl) {
    if (typeof AudioEncoder === 'undefined') {
      if (typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function') {
        noteEl.innerHTML = '<span style="color:#f59e0b; font-weight:700;">⚠️ リアルタイム録画モードで出力されます</span><br><span style="color:#cbd5e1; font-size:11px;">この端末は高速出力非対応のため、曲を再生しながら録画する方式（曲と同じ時間がかかります）で音声付き動画を出力します。</span>';
      } else {
        noteEl.innerHTML = '<span style="color:#f59e0b; font-weight:700;">⚠️ お使いの端末（iOS Safari等）は音声出力非対応です</span><br><span style="color:#cbd5e1; font-size:11px;">Appleの仕様制限により本端末では【映像のみ】書き出されます。音声付きで動画を書き出すには、PC（Google ChromeまたはMicrosoft Edge）からご利用ください。</span>';
      }
    } else if (!S.audio || !S.audio.buffer) {
      noteEl.innerHTML = '<span style="color:#f59e0b; font-weight:700;">⚠️ 楽曲が未設定です（無音出力モード）</span><br><span style="color:#cbd5e1; font-size:11px;">上の「🎵 曲を読み込む」から音楽ファイルを選択すると、動画に音声を結合できます。</span>';
    } else if (!incA) {
      noteEl.innerHTML = '<span style="color:#94a3b8; font-weight:700;">🔇 音声書き出し：OFF</span><br><span style="color:#94a3b8; font-size:11px;">チェックを入れると楽曲「' + (S.audio.name || '') + '」を結合します。</span>';
    } else {
      noteEl.innerHTML = '<span style="color:#10b981; font-weight:700;">✅ 音声結合：準備完了</span><br><span style="color:#cbd5e1; font-size:11px;">楽曲「' + (S.audio.name || '') + '」をAAC音声トラックとして動画に結合します。</span>';
    }
  }
}
async function codecNote() {
  const [w, h] = J.outputSize(S.project);
  const vc = await J.pickVideoCodec(w, h, S.project.fps, 12e6);
  const el = $('codecNote');
  if (el) el.textContent = vc ? `このブラウザでは ${vc.label} で書き出します（${w}×${h} / ${S.project.fps}fps）。書き出し中はタブを開いたままにしてください。` : 'このブラウザは動画エンコード（WebCodecs）に対応していません。Chrome / Edge の最新版で開くか、連番PNGを使ってください。';
  if ($('btnMP4')) $('btnMP4').disabled = !vc;
  if ($('eMP4')) {
    $('eMP4').disabled = !vc;
    if (!vc) $('eMP4').title = 'このブラウザは MP4 書き出しに対応していません（Chrome / Edge 推奨）';
  }
}
const EXP_BTNS = ['btnMP4', 'btnPNG', 'btnPNGA', 'btnPNGL', 'eMP4'];
function baseName() {
  const k = J.keyMode(S.project);
  return ((S.project.title || 'jizura').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'jizura') + (k ? (k === 'green' ? '_greenback' : '_blackback') : '');
}
async function runExport(kind, opts = {}) {
  if (S.exporting) return;

  if (kind === 'mp4') {
    const wantsAudio = S.project.includeAudio !== false && !opts.skipAudio;
    if (wantsAudio && (!S.audio || !S.audio.buffer)) {
      const ok = confirm("【楽曲ファイルが読み込まれていません】\n\n現在、楽曲ファイルが設定されていないため【無音（映像のみ）】で書き出されます。\n\n・音声付きで書き出す場合：「キャンセル」を押して「🎵 曲を読み込む」から曲を選択してください。\n・無音のまま書き出す場合：「OK」を押してください。");
      if (!ok) {
        const af = $('audioFile');
        if (af) af.click();
        return;
      }
    } else if (wantsAudio && typeof AudioEncoder === 'undefined') {
      if (typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function') {
        const durMin = Math.ceil((S.plan.duration || 60) / 60);
        const ok = confirm(`【リアルタイム録画モード】\n\nお使いの端末は高速音声エンコードに非対応のため、リアルタイム録画で音声付き動画を出力します。\n\n・録画時間: 約${durMin}分（曲と同じ長さかかります）\n・お願い: 録画中は画面を消したり別のアプリを開いたりしないでください。\n\n録画を開始しますか？`);
        if (!ok) return;
      } else {
        const ok = confirm("【お使いの端末・ブラウザに関する重要なお知らせ】\n\n現在ご利用の端末・ブラウザ（iPhone / iPad Safari等）は、Appleの仕様制限によりブラウザ内での動画音声エンコード（AudioEncoder）に対応していません。\nそのため、この端末では【映像のみ（無音）】での書き出しとなります。\n\n※音声付きのMP4動画を出力するには、PC（Google ChromeまたはMicrosoft Edge）から本サイトを開いて書き出しを行ってください。\n\nこのまま映像のみで出力しますか？");
        if (!ok) return;
      }
    }
  }

  pause();
  const ac = new AbortController(); S.exporting = ac;
  const boxes = [...document.querySelectorAll('.exp-box')];
  const setText = m => boxes.forEach(b => { b.querySelector('.exp-text').textContent = m; });
  const txt = { set textContent(m) { setText(m); }, get textContent() { return boxes[0].querySelector('.exp-text').textContent; } };
  boxes.forEach(b => {
    b.hidden = false;
    b.querySelector('.exp-bar').style.width = '0%';
    const d = b.querySelector('.exp-done-area');
    if (d) d.style.display = 'none';
  });
  setText('準備中…');
  EXP_BTNS.forEach(id => { $(id).disabled = true; });
  const onProgress = (p, m) => { boxes.forEach(b => { b.querySelector('.exp-bar').style.width = (p * 100).toFixed(1) + '%'; }); setText(m); };
  const t0 = performance.now();
  try {
    await J.ensureFonts(S.project.lyrics + (S.project.title || '') + (S.project.artist || '') + HUD_CHARS, J.fontsOfPlan(S.plan));
    if (kind === 'mp4') {
      const hasAudio = !opts.skipAudio && S.project.includeAudio !== false && S.audio && S.audio.buffer;
      const r = await J.exportMP4({
        plan: S.plan,
        project: S.project,
        audio: hasAudio ? S.audio : null,
        quality: S.project.quality || 'high',
        onProgress,
        signal: ac.signal
      });
      const sizeMB = (r.blob.size / 1048576).toFixed(1);
      const elapsed = ((performance.now() - t0) / 1000).toFixed(0);
      txt.textContent = `完成 ${sizeMB}MB・${r.codec}${r.audio ? ' + ' + (r.audioLabel || r.audio.toUpperCase()) : ''}・${elapsed}秒`;
      
      const ext = r.ext || 'mp4';
      const fileName = baseName() + '.' + ext;
      const blobUrl = URL.createObjectURL(r.blob);
      
      boxes.forEach(b => {
        let doneArea = b.querySelector('.exp-done-area');
        if (!doneArea) {
          doneArea = document.createElement('div');
          doneArea.className = 'exp-done-area';
          b.appendChild(doneArea);
        }
        doneArea.style.display = 'block';
        doneArea.innerHTML = `
          <div style="background:linear-gradient(135deg,#065f46,#047857); color:#fff; border-radius:8px; padding:14px; margin-top:10px; box-shadow:0 4px 14px rgba(4,120,87,0.35); text-align:left;">
            <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px;">
              <div>
                <div style="font-weight:700; font-size:14px;">🎉 MP4動画が完成しました！ (${sizeMB}MB)</div>
                ${r.audio ? `
                  <div style="font-size:12px; color:#a7f3d0; margin-top:3px; font-weight:700;">🎵 音声トラック（${r.audioLabel || r.audio.toUpperCase()}）結合済み</div>
                ` : `
                  <div style="font-size:11px; color:#fde68a; margin-top:3px; font-weight:600; background:rgba(0,0,0,0.25); padding:3px 8px; border-radius:4px;">
                    ⚠️ 音声なし（${r.noAudioReason || '無音で出力されました'}）
                    ${typeof AudioEncoder === 'undefined' ? '<br>※iPhone/iPad等のブラウザは音声エンコードに非対応のため、PC（Chrome/Edge）での書き出しをおすすめします。' : ''}
                  </div>
                `}
                ${r.notice ? `<div style="font-size:11px; color:#fde68a; margin-top:4px; font-weight:600;">⚠️ ${r.notice}</div>` : ''}
              </div>
              <a href="${blobUrl}" download="${fileName}" style="display:inline-flex; align-items:center; gap:6px; background:#fff; color:#065f46; font-weight:800; font-size:13px; padding:8px 18px; border-radius:6px; text-decoration:none; box-shadow:0 2px 6px rgba(0,0,0,0.2);">
                📥 今すぐ保存 (${sizeMB}MB)
              </a>
            </div>
            <div style="margin-top:10px;">
              <div style="font-size:11px; color:#a7f3d0; margin-bottom:4px;">▼ 動画・音声をプレビュー再生</div>
              <video controls preload="metadata" playsinline src="${blobUrl}" style="width:100%; max-height:220px; border-radius:6px; background:#000;"></video>
            </div>
          </div>
        `;
      });

      const res = await J.saveFile(fileName, r.blob);
      if (res === 'declined') txt.textContent += '（保存はキャンセルされました）';
    } else {
      const blob = await J.exportPNGZip({ plan: S.plan, project: S.project, transparent: kind === 'pnga', layers: kind === 'pngl', onProgress, signal: ac.signal });
      txt.textContent = `完成 ${(blob.size / 1048576).toFixed(1)}MB`;
      await J.saveFile(baseName() + (kind === 'pnga' ? '_alpha' : kind === 'pngl' ? '_layers' : '') + '_png.zip', blob);
    }
  } catch (e) {
    const errMsg = (e && e.message ? e.message : String(e));
    txt.textContent = 'エラー: ' + errMsg;
    console.error(e);
    boxes.forEach(b => {
      let doneArea = b.querySelector('.exp-done-area');
      if (!doneArea) {
        doneArea = document.createElement('div');
        doneArea.className = 'exp-done-area';
        b.appendChild(doneArea);
      }
      doneArea.style.display = 'block';
      doneArea.innerHTML = `
        <div style="background:#450a0a; border:1px solid #b91c1c; color:#fecaca; border-radius:8px; padding:14px; margin-top:10px; text-align:left;">
          <div style="font-weight:700; font-size:13px; color:#f87171;">⚠️ 出力エラーが発生しました</div>
          <div style="font-size:12px; margin-top:4px; font-family:monospace; word-break:break-all; background:rgba(0,0,0,0.3); padding:6px; border-radius:4px;">${errMsg}</div>
          <div style="margin-top:10px; display:flex; gap:8px;">
            <button class="btn-retry-no-audio" style="background:#dc2626; color:#fff; border:none; padding:8px 14px; border-radius:6px; font-size:12px; font-weight:700; cursor:pointer;">
              🔇 音声なしで書き出してみる
            </button>
          </div>
        </div>
      `;
      const retryBtn = doneArea.querySelector('.btn-retry-no-audio');
      if (retryBtn) {
        retryBtn.onclick = () => {
          doneArea.style.display = 'none';
          runExport('mp4', { skipAudio: true });
        };
      }
    });
  } finally {
    S.exporting = null; S.need = true;
    EXP_BTNS.forEach(id => { $(id).disabled = false; });
    codecNote();
  }
}

/* ---------------- tap sync ---------------- */
function startTap() {
  if (!S.plan.lines.length) return;
  S.tap = { i: 0 };
  if (!S.project.timing.lineTimes) S.project.timing.lineTimes = {};
  $('tapPanel').hidden = false; $('btnTap').setAttribute('aria-pressed', 'true');
  seek(0); play(); updateTap();
  $('tapBtn').focus();
}
function tapNow() {
  if (!S.tap) return;
  S.project.timing.lineTimes[S.tap.i] = +S.t.toFixed(3);
  S.tap.i++;
  replan();
  if (S.tap.i >= S.plan.lines.length) stopTap(); else updateTap();
}
function stopTap() { S.tap = null; $('tapPanel').hidden = true; $('btnTap').setAttribute('aria-pressed', 'false'); replan(); }
function updateTap() { const ln = S.plan.lines[S.tap.i]; $('tapLine').textContent = ln ? `${S.tap.i + 1}. ${ln.text}` : '—'; }

/* ---------------- sync all inputs from project ---------------- */
function syncUI() {
  $('songTitle').value = S.project.title || ''; $('songArtist').value = S.project.artist || '';
  $('lyrics').value = S.project.lyrics;
  $('bpm').value = S.project.timing.bpm > 0 ? S.project.timing.bpm : '';
  $('bpm').placeholder = S.audio ? `自動 ${S.audio.bpm}` : 'なし';
  $('offset').value = S.project.timing.offset ?? 0.4;
  $('lineScale').value = S.project.timing.lineScale ?? 1;
  $('snap').checked = !!S.project.timing.snap;
  document.querySelectorAll('.wa-toggle').forEach(el => { el.checked = S.project.wa !== false; });
  document.querySelectorAll('.extra-toggle').forEach(el => { el.checked = S.project.extra === true; });
  $('lyricLang').value = J.LANG_LABEL[S.project.lang] ? S.project.lang : 'auto'; langNote();
  renderFontRoles(); renderColors(); renderFx(); renderTech(); syncOut(); drawStyleGrid();
  const tone = S.project.colorTone || 'auto';
  currentColorTone = tone;
  const cList = document.getElementById('colorToneList');
  if (cList) {
    cList.querySelectorAll('.amuvi-genre-chip').forEach(b => {
      b.classList.toggle('active', b.dataset.tone === tone);
    });
  }
  const cHint = document.getElementById('colorToneHint');
  if (cHint) {
    cHint.textContent = tone === 'auto' ? 'スタイルの標準配色' : (J.COLOR_TONES[tone] ? J.COLOR_TONES[tone].hint : '');
  }
  updateAvoidMarkerUI();
}

/* ---------------- wiring ---------------- */
function bind() {
  $('lyrics').addEventListener('input', e => { S.project.lyrics = e.target.value; replanSoon(260); });
  $('lyricLang').addEventListener('change', e => {
    remember();
    S.project.lang = e.target.value; replan(); renderFontRoles(); commit(); flushSave();
    const l = J.resolveLang(S.project);
    toast((S.project.lang === 'auto' ? '歌詞の言語：自動判定 → ' : '歌詞の言語：') + J.LANG_LABEL[l]);
  });
  $('songTitle').addEventListener('input', e => { S.project.title = e.target.value; replanSoon(300); });
  $('songArtist').addEventListener('input', e => { S.project.artist = e.target.value; replanSoon(300); });
  $('btnSyntax').addEventListener('click', e => { const s = $('syntax'); s.hidden = !s.hidden; e.target.setAttribute('aria-expanded', String(!s.hidden)); });
  $('bpm').addEventListener('change', e => { S.project.timing.bpm = Math.max(0, parseFloat(e.target.value) || 0); replan(); });
  $('offset').addEventListener('change', e => { S.project.timing.offset = Math.max(0, parseFloat(e.target.value) || 0); replan(); });
  $('lineScale').addEventListener('change', e => { S.project.timing.lineScale = J.clamp(parseFloat(e.target.value) || 1, 0.3, 4); replan(); });
  $('snap').addEventListener('change', e => { S.project.timing.snap = e.target.checked; replan(); });
  $('btnResetTimes').addEventListener('click', () => { S.project.timing.lineTimes = {}; replan(); });
  /* Background image & character standing artwork */
  S.bgImageUrl = null; window._bgImgObj = null;
  S.charFgUrl = null; window._charFgImgObj = null;

  function updateLayerBar() {
    const bar = document.getElementById('bgImageBar');
    const bgRow = document.getElementById('bgRow');
    const charRow = document.getElementById('charRow');
    const hasBg = !!window._bgImgObj;
    const hasChar = !!window._charFgImgObj || (J.depth && J.depth.ready(window._bgImgObj));
    if (bar) bar.style.display = (hasBg || hasChar) ? 'flex' : 'none';
    if (bgRow) bgRow.style.display = hasBg ? 'flex' : 'none';
    if (charRow) charRow.style.display = window._charFgImgObj ? 'flex' : 'none';
    updateDepthUI();
  }

  $('bgImageFile')?.addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const url = URL.createObjectURL(f);
    S.bgImageUrl = url;
    window._bgImgObj = new Image();
    window._bgImgObj.onload = () => {
      if (J.depth) J.depth.clear();
      updateLayerBar();
      S.need = true; draw();
    };
    window._bgImgObj.src = url;
    const layer = document.getElementById('bgImageLayer');
    if (layer) layer.style.backgroundImage = `url('${url}')`;
    const nameEl = document.getElementById('bgImageName');
    if (nameEl) nameEl.textContent = f.name;
    updateLayerBar();
    S.need = true;
  });

  $('charImageFile')?.addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const url = URL.createObjectURL(f);
    S.charFgUrl = url;
    window._charFgImgObj = new Image();
    window._charFgImgObj.onload = () => {
      S.project.depth = S.project.depth || 'behind';
      updateLayerBar();
      replan(); commit(); S.need = true; draw();
      toast('👤 キャラ立ち絵を読み込みました！リリックがキャラの後ろを通過します');
    };
    window._charFgImgObj.src = url;
    const nameEl = document.getElementById('charImageName');
    if (nameEl) nameEl.textContent = f.name;
    updateLayerBar();
  });

  document.getElementById('btnClearBg')?.addEventListener('click', () => {
    S.bgImageUrl = null; window._bgImgObj = null;
    if (J.depth) J.depth.clear();
    const layer = document.getElementById('bgImageLayer');
    if (layer) layer.style.backgroundImage = '';
    const fi = document.getElementById('bgImageFile');
    if (fi) fi.value = '';
    updateLayerBar();
    replan(); commit(); S.need = true; draw();
  });

  document.getElementById('btnClearChar')?.addEventListener('click', () => {
    S.charFgUrl = null; window._charFgImgObj = null;
    const fi = document.getElementById('charImageFile');
    if (fi) fi.value = '';
    updateLayerBar();
    replan(); commit(); S.need = true; draw();
    toast('キャラ画像を解除しました');
  });
  $('audioFile').addEventListener('change', e => { const f = e.target.files && e.target.files[0]; if (f) loadAudioFile(f); });

  $('srtFile')?.addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    if (f) {
      const reader = new FileReader();
      reader.onload = e => {
        if (document.getElementById('srtLyrics')) {
            document.getElementById('srtLyrics').value = e.target.result;
            document.getElementById('srtLyrics').dispatchEvent(new Event('input'));
        }
      };
      reader.readAsText(f);
    }
  });

  $('btnTap').addEventListener('click', () => (S.tap ? stopTap() : startTap()));
  $('tapBtn').addEventListener('click', tapNow);
  $('tapStop').addEventListener('click', () => { pause(); stopTap(); });
  $('btnPlay').addEventListener('click', () => (S.playing ? pause() : play()));
  if ($('btnLoop')) $('btnLoop').addEventListener('click', e => { S.loop = !S.loop; e.target.setAttribute('aria-pressed', String(S.loop)); });
  $('btnShuffle').addEventListener('click', () => { remember(); S.project.seed = (Math.random() * 1e9) | 0; $('seed').value = S.project.seed; replan(); commit(); });
  const sc = $('scrub');
  sc.addEventListener('input', () => { S.scrubbing = true; seek(sc.value / 10000 * S.plan.duration); });
  sc.addEventListener('change', () => { S.scrubbing = false; });
  const tl = $('timeline');
  let drag = false;
  tl.addEventListener('pointerdown', e => { drag = true; tl.setPointerCapture(e.pointerId); timelineSeek(e); });
  tl.addEventListener('pointermove', e => { if (drag) timelineSeek(e); });
  tl.addEventListener('pointerup', () => { drag = false; });
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    document.querySelectorAll('.tabpane').forEach(p => { p.hidden = p.dataset.pane !== b.dataset.tab; });
    if (b.dataset.tab === 'out') codecNote();
    loadThumbFonts();
  }));
  $('fxFlash').addEventListener('change', e => { S.project.fx.flash = e.target.checked; replan(); });
  $('techFilter').addEventListener('input', () => renderTech());
  const setSwitch = (cls, key, on, msgOn, msgOff) => document.querySelectorAll('.' + cls).forEach(el => el.addEventListener('change', e => {
    remember();
    S.project[key] = e.target.checked;
    document.querySelectorAll('.' + cls).forEach(x => { x.checked = e.target.checked; });
    renderTech(); drawStyleGrid(); replan(); commit(); flushSave();
    toast(e.target.checked ? msgOn : msgOff);
  }));
  setSwitch('extra-toggle', 'extra', true, '追加分の演出：使う', '追加分の演出：使わない（最初の公開版の演出だけ）');
  setSwitch('wa-toggle', 'wa', true, '和風の演出：使う', '和風の演出：使わない（おまかせ・シャッフルで選ばれません）');
  $('fxKoma').addEventListener('change', e => { const k = +e.target.value; S.project.fx.koma = k; S.project.fx.onTwos = k > 0; S.project.mood = null; replan(); });
  $('fxHud').addEventListener('change', e => { S.project.fx.hud = e.target.value; replan(); });
  $('seed').addEventListener('change', e => { S.project.seed = parseInt(e.target.value, 10) || 0; replan(); });
  $('btnSeed').addEventListener('click', () => { S.project.seed = (Math.random() * 1e9) | 0; $('seed').value = S.project.seed; replan(); });
  const colorToggle = (flag, keys) => e => {
    remember();
    const c = S.project.colors; c[flag] = e.target.checked;
    if (c[flag]) { const sc0 = J.STYLES[S.project.style].schemes[0]; keys.forEach(([k]) => { if (!c[k]) c[k] = sc0[k]; }); }
    renderColors(); replan(); commit();
  };
  $('colorOn').addEventListener('change', colorToggle('enabled', BASE_KEYS));
  $('accentOn').addEventListener('change', colorToggle('accentOn', ACCENT_KEYS));
  $('btnRandPalette').addEventListener('click', randomPalette);
  $('btnAddFont').addEventListener('click', () => {
    const name = $('localFont').value.trim(); if (!name) return;
    const key = 'local_' + name.replace(/\s+/g, '_');
    const weight = /bold|太|black|heavy|w[6-9]|[6-9]00/i.test(name) ? 700 : 400;
    J.addUserFont(key, name + '（PC）', name, weight);
    S.project.userFonts = (S.project.userFonts || []).filter(u => u.key !== key).concat([{ key, label: name + '（PC）', family: name, weight }]);
    S.project.fonts.display = key; $('localFont').value = '';
    fontKey = ''; renderFontRoles(); replan();
  });
  $('fontFile').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    try { const key = await J.loadFontFile(f); S.project.fonts.display = key; fontKey = ''; renderFontRoles(); replan(); }
    catch (err) { showMsg('フォントを読み込めませんでした'); setTimeout(() => showMsg(null), 2500); }
  });
  ['outAspect', 'eAspect'].forEach(id => $(id).addEventListener('change', e => { S.project.aspect = e.target.value; syncOut(); replan(); codecNote(); }));
  ['outRes', 'eRes'].forEach(id => $(id).addEventListener('change', e => { S.project.res = +e.target.value; syncOut(); autosave(); codecNote(); }));
  ['outFps', 'eFps'].forEach(id => $(id).addEventListener('change', e => { S.project.fps = +e.target.value; syncOut(); replan(); codecNote(); }));
  const ems = $('eMotionSmooth');
  if (ems) {
    ems.addEventListener('change', e => {
      const mode = e.target.value;
      S.project.motionSmooth = mode;
      if (mode === 'smooth60') {
        S.project.fps = 60;
        S.project.fx.koma = 0;
        S.project.fx.onTwos = false;
        toast('動き：超なめらか (60fps・ヌルヌル)');
      } else if (mode === 'smooth50') {
        S.project.fps = 50;
        S.project.fx.koma = 0;
        S.project.fx.onTwos = false;
        toast('動き：ややなめらか (50fps)');
      } else if (mode === 'smooth45') {
        S.project.fps = 45;
        S.project.fx.koma = 0;
        S.project.fx.onTwos = false;
        toast('動き：中間なめらか (45fps)');
      } else if (mode === 'smooth30') {
        S.project.fps = 30;
        S.project.fx.koma = 0;
        S.project.fx.onTwos = false;
        toast('動き：標準なめらか (30fps)');
      } else if (mode === 'anime') {
        S.project.fps = 24;
        S.project.fx.koma = 12;
        S.project.fx.onTwos = true;
        toast('動き：アニメ調 (2コマ打ち・文字PV風)');
      }
      S.project.mood = null;
      syncOut();
      replan();
      codecNote();
      S.need = true;
      draw();
    });
  }
  $('outQuality').addEventListener('change', e => { S.project.quality = e.target.value; autosave(); });
  ['outKey', 'eKey'].forEach(id => $(id).addEventListener('change', e => {
    S.project.keyBg = e.target.value; syncOut(); replan(); flushSave();
    const k = J.keyMode(S.project);
    toast(k ? `背景：${k === 'green' ? 'グリーンバック' : 'ブラックバック'}（白い文字と演出だけ）` : '背景：通常（スタイルの配色）');
  }));
  ['outAudio', 'eAudio'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('change', e => { S.project.includeAudio = e.target.checked; syncOut(); autosave(); });
  });
  const ebb = $('eBlackBackUI');
  if (ebb) {
    ebb.addEventListener('change', e => {
      S.project.keyBg = e.target.checked ? 'black' : 'off';
      syncOut(); replan(); flushSave();
      const k = J.keyMode(S.project);
      toast(k === 'black' ? '背景：ブラックバック（文字と演出のみ）' : '背景：通常（スタイルの配色）');
    });
  }
  $('btnMP4').addEventListener('click', () => runExport('mp4'));
  $('btnPNG').addEventListener('click', () => runExport('png'));
  $('btnPNGA').addEventListener('click', () => runExport('pnga'));
  $('btnPNGL').addEventListener('click', () => runExport('pngl'));
  document.querySelectorAll('.exp-cancel').forEach(b => b.addEventListener('click', () => { if (S.exporting) S.exporting.abort(); }));
  $('eMP4').addEventListener('click', () => runExport('mp4'));
  // かんたんモード
  $('modeEasy').addEventListener('click', () => setMode('easy'));
  $('modePro').addEventListener('click', () => setMode('pro'));
  $('btnOmakase').addEventListener('click', omakase);
  $('btnOmakaseBig').addEventListener('click', omakase);
  ['btnPrev', 'btnPrev2'].forEach(id => $(id).addEventListener('click', () => histGo(-1)));
  ['btnNext', 'btnNext2'].forEach(id => $(id).addEventListener('click', () => histGo(1)));
  $('eStyle').addEventListener('click', () => rerollPart('style'));
  $('eMood').addEventListener('click', () => rerollPart('mood'));
  $('eCut').addEventListener('click', () => rerollPart('cut'));
  $('ePalette').addEventListener('click', () => { randomPalette(); restartPreview(); });
  // 利用について（出力物の権利・ライセンス）
  const dlg = $('termsDlg');
  const openTerms = () => { if (dlg.showModal) { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute('open', ''); };
  document.querySelectorAll('.terms-open').forEach(b => b.addEventListener('click', openTerms));
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close ? dlg.close() : dlg.removeAttribute('open'); });   // click on the backdrop
  $('btnSave').addEventListener('click', () => J.saveFile(baseName() + '.jizura.json', JSON.stringify(S.project, null, 1)));
  $('btnAE').addEventListener('click', () => J.saveFile(baseName() + '_ae.json', JSON.stringify(J.planForAE(S.plan, S.project), null, 1)));
  $('fileProject').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    try { S.project = mergeProject(JSON.parse(await f.text())); syncUI(); replan(); }
    catch (err) { showMsg('プロジェクトを読み込めませんでした'); setTimeout(() => showMsg(null), 2500); }
    e.target.value = '';
  });
  document.addEventListener('keydown', e => {
    const tag = (e.target && e.target.tagName) || '';
    const typing = /INPUT|TEXTAREA|SELECT/.test(tag) && e.target.type !== 'range' && e.target.type !== 'checkbox';
    if (S.tap && (e.code === 'Space' || e.code === 'Enter') && !typing) { e.preventDefault(); tapNow(); return; }
    if (S.tap && e.code === 'Escape') { pause(); stopTap(); return; }
    if (typing || $('termsDlg').open) return;
    if (e.code === 'Space') { e.preventDefault(); S.playing ? pause() : play(); }
    else if (e.code === 'ArrowRight') seek(S.t + (e.shiftKey ? 1 : 1 / S.plan.fps));
    else if (e.code === 'ArrowLeft') seek(S.t - (e.shiftKey ? 1 : 1 / S.plan.fps));
    else if (e.code === 'KeyR' && !e.metaKey && !e.ctrlKey && !e.altKey && !S.exporting) { e.preventDefault(); omakase(); }
  });
  window.addEventListener('resize', () => { sizeViewport(); drawTimeline(); });
  if (window.ResizeObserver) new ResizeObserver(() => { sizeViewport(); drawTimeline(); }).observe($('viewport'));
}

/* song file -> beat analysis (file input, or a host such as the After Effects panel) */
async function loadAudioFile(f) {
  $('audioName').textContent = '解析中…';
  try {
    pause();
    S.audio = await J.analyzeAudio(f);
    $('audioName').innerHTML = `<span style="color:#059669; font-weight:700;">🎵 ${f.name}</span> <span style="color:#64748b; font-size:11px;">（${J.fmtTime(S.audio.duration)}・約${S.audio.bpm}BPM）</span>`;
    S.project.timing.snap = true;
    S.project.includeAudio = true;
    syncUI(); syncOut(); replan();
    toast(`楽曲「${f.name}」を読み込みました`);
    return true;
  } catch (err) { $('audioName').innerHTML = `<span style="color:#dc2626; font-weight:600;">読み込めませんでした: ${err.message}</span>`; S.audio = null; syncOut(); return false; }
}

/* ---------------- boot ---------------- */
function boot() {
  S.project = loadLocal();
  const layer = document.getElementById('bgImageLayer');
  if (layer && S.bgImageUrl) layer.style.backgroundImage = `url('${S.bgImageUrl}')`;
  if (S.bgImageUrl) { window._bgImgObj = new Image(); window._bgImgObj.src = S.bgImageUrl; }
  bind(); initVolume(); syncUI(); replan();
  initGenreSelector();
  initColorToneSelector();
  initAvoidArea();
  initDepthControls();
  updateDepthUI();
  let mode = 'easy'; try { mode = localStorage.getItem('jizura.mode') || 'easy'; } catch (e) {}
  setMode(mode); commit();
  
  // Parse bookmarklet URL hash
  const hash = window.location.hash.substring(1);
  if (hash) {
    const params = new URLSearchParams(hash);
    const lrc = params.get('lrc');
    const audioUrl = params.get('audio_url');
    if (lrc) {
      S.project.lyrics = lrc;
      $('lyrics').value = lrc;
      syncUI(); replan(); flushSave();
      toast('歌詞を読み込みました');
    }
    if (audioUrl) {
      toast('音源をダウンロード中…');
      fetch(audioUrl).then(r => r.blob()).then(blob => {
        const file = new File([blob], 'suno_audio.mp3', { type: 'audio/mpeg' });
        loadAudioFile(file);
      }).catch(e => toast('音源の取得に失敗しました'));
    }
    window.location.hash = '';
  }

  // open on a representative frame (end of the first cut's entrance)
  const c0 = S.plan.cuts.find(c => c.line >= 0);
  if (c0) seek(c0.start + Math.min(c0.dur * 0.6, c0.inDur + 0.25));
  requestAnimationFrame(tick);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
J.ui = S;
// hooks for hosts that embed the app (the After Effects CEP panel)
J.uiApi = { toast, replan, syncUI, pause, seek, flushSave, loadAudioFile, restartPreview };
})();
