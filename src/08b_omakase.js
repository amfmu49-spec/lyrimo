/* ============================================================
   JIZURA — おまかせ (full one-button randomiser) & mood presets
   Each mood sets slider ranges, a preferred subset of techniques
   and styles, and font biases. J.omakase(project) returns a new
   partial project state that replaces style, mood, fx, enabled,
   fonts, colors and seed while keeping lyrics, timing and output.
   ============================================================ */
(() => {
'use strict';

J.MOODS = {
  glitch:    { name: 'グリッチ',       fx: { motion: [0.65, 0.95], glitch: [0.6, 0.95], chroma: [0.65, 1], decor: [0.4, 0.8], density: [0.6, 0.9], texture: [0.4, 0.8], bgSwitch: [0.4, 0.8] },
    layout: ['huge', 'marquee', 'scatter', 'tile', 'labels', 'type', 'condensed'], enter: ['scramble', 'slice', 'flicker', 'assemble', 'type'], exit: ['glitch', 'slice', 'explode'], styles: ['noir', 'crimson', 'mint', 'hud', 'mono'] },
  calm:      { name: 'しっとり',       fx: { motion: [0.3, 0.55], glitch: [0, 0.18], chroma: [0.1, 0.4], decor: [0.15, 0.45], density: [0.2, 0.45], texture: [0.5, 0.9], bgSwitch: [0.1, 0.35] },
    layout: ['vcols', 'stack', 'gloss', 'center', 'mixed'], enter: ['blur', 'wipe', 'type'], exit: ['blur', 'drift', 'wipe'], styles: ['paper', 'specimen', 'noir', 'mono', 'rouge'] },
  pop:       { name: 'ポップ',         fx: { motion: [0.7, 1], glitch: [0.1, 0.4], chroma: [0.3, 0.65], decor: [0.55, 0.95], density: [0.55, 0.85], texture: [0.2, 0.5], bgSwitch: [0.45, 0.85] },
    layout: ['wave', 'pill', 'huge', 'ring', 'circle', 'scatter', 'mixed'], enter: ['pop', 'drop', 'spin', 'zoom'], exit: ['scatter', 'shrink', 'explode'], styles: ['magenta', 'caution', 'transit', 'blueprint', 'rouge'] },
  graphic:   { name: 'グラフィック',   fx: { motion: [0.55, 0.85], glitch: [0.2, 0.55], chroma: [0.3, 0.7], decor: [0.6, 1], density: [0.5, 0.8], texture: [0.3, 0.7], bgSwitch: [0.4, 0.85] },
    layout: ['diag', 'ring', 'circle', 'condensed', 'tile', 'labels', 'mixed', 'pill'], enter: ['wipe', 'slice', 'stretch', 'spin', 'pop'], exit: ['wipe', 'slice', 'stretch', 'shrink'], styles: ['caution', 'blueprint', 'transit', 'crimson', 'hud', 'mint'] },
  editorial: { name: 'エディトリアル', fx: { motion: [0.35, 0.65], glitch: [0.05, 0.25], chroma: [0.15, 0.45], decor: [0.4, 0.75], density: [0.3, 0.6], texture: [0.5, 0.95], bgSwitch: [0.2, 0.5] },
    layout: ['gloss', 'vcols', 'mixed', 'stack', 'type', 'center', 'circle'], enter: ['type', 'blur', 'wipe', 'assemble'], exit: ['blur', 'drift', 'wipe'], styles: ['specimen', 'paper', 'noir', 'mono', 'hud'] },
  emotional: { name: 'エモーショナル', fx: { motion: [0.55, 0.85], glitch: [0.3, 0.6], chroma: [0.5, 0.85], decor: [0.3, 0.6], density: [0.4, 0.7], texture: [0.6, 1], bgSwitch: [0.2, 0.5] },
    layout: ['huge', 'center', 'vcols', 'stack', 'condensed', 'mixed', 'circle'], enter: ['assemble', 'blur', 'zoom', 'wipe', 'slice'], exit: ['drift', 'explode', 'fall', 'blur'], styles: ['noir', 'paper', 'hud', 'mono', 'crimson'] },
  // ホラー: only offered when the project's ホラー switch is on (the horror set's parts come with it)
  horror:    { name: 'ホラー', set: 'horror', fx: { motion: [0.35, 0.65], glitch: [0.3, 0.7], chroma: [0.2, 0.5], decor: [0.3, 0.6], density: [0.3, 0.55], texture: [0.7, 1], bgSwitch: [0.1, 0.3] },
    layout: ['center', 'vcols', 'stack', 'huge', 'type'], enter: ['flicker', 'blur', 'type', 'scramble'], exit: ['blur', 'glitch', 'fall', 'drift'], styles: ['noir', 'mono', 'crimson'], noHold: ['wave'], sprinkle: 0.1 },
  chaos:     { name: '全部入り', fx: { motion: [0.5, 1], glitch: [0.3, 1], chroma: [0.4, 1], decor: [0.4, 1], density: [0.45, 0.9], texture: [0.3, 1], bgSwitch: [0.3, 0.9] },
    layout: null, enter: null, exit: null, styles: null },
};

/* tag the core items so J.taggedWith works across core + packs */
(() => {
  const add = (g, k, m) => { const d = J.registry(g)[k]; if (!d) return; d.tags = d.tags || []; if (!d.tags.includes(m)) d.tags.push(m); };
  for (const [m, M] of Object.entries(J.MOODS)) for (const g of ['layout', 'enter', 'exit']) for (const k of M[g] || []) add(g, k, m);
  const extra = {
    hold: { still: ['calm', 'editorial'], drift: ['calm', 'emotional'], breathe: ['calm', 'emotional', 'editorial'], wave: ['pop', 'emotional'], jitter: ['glitch', 'emotional'], stepScale: ['pop', 'graphic', 'glitch'] },
    decor: { hud: ['glitch', 'graphic', 'editorial'], rings: ['graphic', 'pop', 'emotional'], leaders: ['editorial', 'pop'], bars: ['editorial', 'calm'], stripes: ['graphic', 'pop'], shapes: ['pop', 'graphic'], sparks: ['pop', 'emotional'], arrows: ['graphic', 'pop'], counter: ['graphic', 'editorial', 'glitch'], barcode: ['graphic', 'glitch', 'editorial'], grid: ['graphic', 'editorial'], slash: ['graphic', 'glitch'], dots: ['pop', 'graphic'], blobs: ['calm', 'pop', 'emotional'], waveform: ['glitch', 'emotional'] },
    fx: { chroma: ['glitch', 'emotional', 'pop'], shake: ['glitch', 'pop', 'emotional'], slice: ['glitch'], block: ['glitch'], invert: ['glitch', 'graphic'], flash: ['pop', 'glitch', 'emotional'], zoom: ['emotional', 'pop'], mosaic: ['glitch'] },
  };
  for (const [g, map] of Object.entries(extra)) for (const [k, ms] of Object.entries(map)) ms.forEach(m => add(g, k, m));
})();

/* テーマ: おまかせ within one direction. A theme picks among its moods, turns on the part switches it needs
   (returned with the result) and always keeps the parts of its set / 和風 as candidates. No theme = the usual おまかせ. */
J.THEMES = {
  lyricpv: { name: '文字PV', moods: ['editorial', 'graphic', 'emotional'], set: 'typo' },
  kinetic: { name: 'キネティック', moods: ['pop', 'graphic', 'glitch'], set: 'kinetic' },
  wa:      { name: '和風', moods: ['calm', 'emotional', 'editorial'], wa: true },
  horror:  { name: 'ホラー', moods: ['horror'], set: 'horror' },
  pop:     { name: 'ポップ', moods: ['pop'] },
  ballad:  { name: 'バラード', moods: ['calm', 'emotional'], koma: [0, 0, 12] },
  rock:    { name: 'ロック', moods: ['emotional', 'graphic'] },
  cyber:   { name: 'サイバー', moods: ['glitch'] },
  chill:   { name: 'チル', moods: ['editorial', 'calm'] },
};
J.THEME_ORDER = ['lyricpv', 'kinetic', 'wa', 'horror', 'pop', 'ballad'];

J.omakase = (project, rnd = Math.random, themeId = null) => {
  const T = themeId && J.THEMES[themeId] ? J.THEMES[themeId] : null;
  const switches = {};
  if (T && T.set) switches[T.set] = true;
  if (T && T.wa) { switches.wa = true; switches.extra = true; }     // most 和風 parts belong to 追加分
  if (T) project = Object.assign({}, project, switches);
  const themePart = d => !!(T && d && ((T.set && d.set === T.set) || (T.wa && d.wa)));
  const pick = a => a[Math.floor(rnd() * a.length) % a.length];
  const range = r => +(r[0] + (r[1] - r[0]) * rnd()).toFixed(2);
  const moodOk = k => !J.MOODS[k].set || (J.setOn && J.setOn(project, J.MOODS[k].set));
  let moods = Object.keys(J.MOODS).filter(k => k !== project.mood && moodOk(k));
  if (T) { const tm = T.moods.filter(k => J.MOODS[k] && moodOk(k)); moods = tm.filter(k => k !== project.mood); if (!moods.length) moods = tm.length ? tm : Object.keys(J.MOODS).filter(moodOk); }
  // with the ホラー switch on, おまかせ leans to the ホラー mood (it may repeat)
  const mood = !T && moodOk('horror') && rnd() < 0.55 ? 'horror' : pick(moods), M = J.MOODS[mood];
  // a set tied to a mood (ホラー) is only used in that mood
  const moodSetOk = d => !(d && d.set) || !Object.values(J.MOODS).some(m => m.set === d.set) || M.set === d.set;
  // style: mostly one that suits the mood, sometimes anything; never the same twice in a row
  // (only styles the 追加分 / 和風 switches allow)
  const okStyle = k => J.STYLES[k] && (!J.randomOk || J.randomOk(project, 'style', k)) && moodSetOk(J.STYLES[k]);
  const moodStyles = [...new Set([...(M.styles || []), ...J.STYLE_ORDER.filter(k => (J.STYLES[k].moods || []).includes(mood))])].filter(okStyle);
  let pool = (moodStyles.length && rnd() < 0.72 ? moodStyles : J.STYLE_ORDER.filter(okStyle)).filter(k => k !== project.style);
  if (T) { const ts = J.STYLE_ORDER.filter(k => okStyle(k) && themePart(J.STYLES[k]) && k !== project.style); if (ts.length && rnd() < 0.8) pool = ts; }
  if (!pool.length) pool = J.STYLE_ORDER.filter(k => k !== project.style && okStyle(k));
  if (!pool.length) pool = J.STYLE_ORDER.filter(k => k !== project.style);
  const style = pick(pool);
  const fx = Object.assign({}, project.fx);
  for (const k of Object.keys(M.fx)) fx[k] = range(M.fx[k]);
  if (project.motionSmooth && project.motionSmooth.startsWith('smooth')) {
    fx.koma = 0;
  } else if (project.motionSmooth === 'anime') {
    fx.koma = 12;
  } else {
    fx.koma = pick(T && T.koma ? T.koma : { horror: [12, 8, 0], glitch: [12, 12, 8], pop: [12, 12, 8, 0], calm: [0, 0, 12], editorial: [0, 12], emotional: [12, 0], graphic: [12, 12, 0] }[mood] || [12, 8, 0]);
  }
  fx.onTwos = fx.koma > 0; fx.flash = rnd() < 0.65; fx.hud = pick(['auto', 'auto', 'on', 'off']);
  // technique subset per group: everything tagged with the mood (plus the mood's hand-picked core items),
  // a sprinkle of everything else, and a minimum count so the planner always has room to vary
  const enabled = {};
  const MIN = { layout: 6, enter: 5, exit: 5, hold: 3, decor: 6, treat: 4, bg: 4, cam: 3, fx: 4, trans: 3 };
  for (const g of J.GROUP_KEYS) {
    const order = J.order(g).filter(k => !(J.registry(g)[k] || {}).special && (!J.randomOk || J.randomOk(project, g, k)) && moodSetOk(J.registry(g)[k]));
    const hand = ['layout', 'enter', 'exit'].includes(g) && Array.isArray(M[g]) ? M[g] : [];   // (M.fx holds slider ranges, not a list)
    const prefer = mood === 'chaos' ? null : new Set([...hand, ...J.taggedWith(g, mood)]);
    if (prefer && T) for (const k of order) if (themePart(J.registry(g)[k])) prefer.add(k);   // the theme's own parts stay in
    const on = {};
    // entries of a set tied to another mood are switched off explicitly (a missing key would count as enabled)
    for (const k of J.order(g)) if (!moodSetOk(J.registry(g)[k])) on[k] = false;
    for (const k of order) on[k] = prefer ? (prefer.has(k) || rnd() < (M.sprinkle || 0.22)) : rnd() < 0.8;
    const offs = order.filter(k => !on[k]);
    let n = order.length - offs.length;
    while (n < Math.min(MIN[g] || 3, order.length) && offs.length) { const k = offs.splice(Math.floor(rnd() * offs.length), 1)[0]; on[k] = true; n++; }
    if (M.noHold && g === 'hold') M.noHold.forEach(k => { on[k] = false; });
    enabled[g] = on;
  }
  // font overrides: 60% use the style's own faces, 40% pick a fresh display/serif face from the catalogue
  const fonts = {};
  const okFont = k => J.FONTS[k] && (!J.randomOk || J.randomOk(project, 'font', k));
  if (rnd() < 0.45) {
    const disp = ['gothic_black', 'dela', 'zenkaku', 'mincho_black', 'tokumin', 'round', 'pop', 'dot', 'brush', 'reggae', 'rampart', 'potta', 'kiwi', 'klee', 'shippori'].filter(okFont);
    if (disp.length) fonts.display = pick(disp);
  }
  if (rnd() < 0.35) {
    const ser = ['mincho_black', 'mincho_bold', 'mincho', 'mincho_light', 'tokumin', 'brush', 'shippori', 'klee', 'kiwi'].filter(okFont);
    if (ser.length) fonts.serif = pick(ser);
  }
  // colours: 65% style's own palette, 35% a fresh accent + chromatic pair fitted to the style's main background
  const colors = { enabled: false, accentOn: false };
  if (rnd() < 0.38) {
    const p = J.randomPalette(J.STYLES[style].schemes[0].bg, rnd);
    Object.assign(colors, { accentOn: true, accent: p.accent, ghostA: p.ghostA, ghostB: p.ghostB });
  }
  // keep locked lines, drop other per-line picks
  const overrides = {};
  for (const [i, o] of Object.entries(project.overrides || {})) if (o.lock) overrides[i] = o; else if (o.cutTime) overrides[i] = { cutTime: o.cutTime };   // cut times are timing, not the look
  return Object.assign({ mood, style, fx, enabled, fonts, colors, overrides, seed: Math.floor(rnd() * 1e9) }, switches);
};
})();
