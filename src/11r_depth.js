/* ============================================================
   JIZURA — キャラ自動検出: anime-character segmentation of the background image
   Runs fully in the browser (onnxruntime-web + skytnt/anime-seg ISNet). The image never leaves the device;
   only the engine and the model are downloaded (the model is kept in the Cache Storage after the first time).
   ============================================================ */
(() => {
'use strict';
const ORT_DIR = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
const ORT_URL = ORT_DIR + 'ort.webgpu.min.js';        // WebGPU + WASM in one bundle
const MODEL_URL = 'https://huggingface.co/skytnt/anime-seg/resolve/main/isnetis.onnx';
const MODEL_SIZE = 176069933;
const CACHE_NAME = 'lyrimo-models-v1';
const S = 1024;                                        // model input: 1x3x1024x1024, RGB 0..1, letterboxed with black

/* cover-fit rect of an iw x ih image inside W x H (same as CSS background-size: cover, centred) */
J.coverRect = (iw, ih, W, H) => {
  const k = Math.max(W / Math.max(1, iw), H / Math.max(1, ih));
  const w = iw * k, h = ih * k;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
};

const D = J.depth = { src: null, fg: null, box: null, busy: false, backend: null };
let ortP = null, sess = null, sessBackend = null;

function loadOrt() {
  if (window.ort && window.ort.InferenceSession) return Promise.resolve(window.ort);
  return ortP || (ortP = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = ORT_URL; s.crossOrigin = 'anonymous'; s.async = true;
    s.onload = () => {
      const ort = window.ort;
      if (!ort || !ort.InferenceSession) { ortP = null; rej(new Error('AIエンジンを初期化できませんでした')); return; }
      ort.env.wasm.wasmPaths = ORT_DIR;
      ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
      res(ort);
    };
    s.onerror = () => { ortP = null; rej(new Error('AIエンジンを読み込めませんでした（ネット接続を確認してください）')); };
    document.head.appendChild(s);
  }));
}

async function fetchModel(onProgress) {
  let cache = null;
  try {
    cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(MODEL_URL);
    if (hit) { const b = new Uint8Array(await hit.arrayBuffer()); if (b.length > 1e6) { onProgress('model', 1); return b; } }
  } catch (e) { cache = null; }
  const r = await fetch(MODEL_URL, { mode: 'cors' });
  if (!r.ok || !r.body) throw new Error(`AIモデルをダウンロードできませんでした（${r.status}）`);
  const total = +r.headers.get('content-length') || MODEL_SIZE;
  const reader = r.body.getReader(), chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    onProgress('model', Math.min(0.999, got / total));
  }
  const buf = new Uint8Array(got); let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  if (cache) { try { await cache.put(MODEL_URL, new Response(buf, { headers: { 'content-type': 'application/octet-stream' } })); } catch (e) { /* quota: just re-download next time */ } }
  onProgress('model', 1);
  return buf;
}

async function makeSession(ort, bytes, preferGpu) {
  const opts = { graphOptimizationLevel: 'all' };
  if (preferGpu && navigator.gpu) {
    try { const s = await ort.InferenceSession.create(bytes, Object.assign({ executionProviders: ['webgpu'] }, opts)); sessBackend = 'WebGPU'; return s; }
    catch (e) { console.warn('depth: WebGPU unavailable, falling back to WASM', e); }
  }
  const s = await ort.InferenceSession.create(bytes, Object.assign({ executionProviders: ['wasm'] }, opts));
  sessBackend = 'WASM'; return s;
}

let modelBytes = null;
async function getSession(onProgress) {
  if (sess) return sess;
  onProgress('engine', 0);
  const ort = await loadOrt();
  modelBytes = modelBytes || await fetchModel(onProgress);
  onProgress('init', 0);
  sess = await makeSession(ort, modelBytes, true);
  return sess;
}

/* run the model on an <img>; builds D.fg (character cut-out, image resolution) and D.box (normalised to the image) */
D.detect = async (img, onProgress = () => {}) => {
  if (!img || !img.naturalWidth) throw new Error('背景画像がまだ読み込まれていません');
  if (D.src === img.src && D.fg) return D;
  if (D.busy) throw new Error('検出中です');
  D.busy = true;
  try {
    const ort = await loadOrt();
    let session = await getSession(onProgress);
    onProgress('run', 0);
    const w0 = img.naturalWidth, h0 = img.naturalHeight;
    let w, h;
    if (h0 > w0) { h = S; w = Math.max(1, Math.round(S * w0 / h0)); } else { w = S; h = Math.max(1, Math.round(S * h0 / w0)); }
    const ox = (S - w) >> 1, oy = (S - h) >> 1;
    const c = document.createElement('canvas'); c.width = S; c.height = S;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.fillStyle = '#000'; x.fillRect(0, 0, S, S);
    x.imageSmoothingQuality = 'high';
    x.drawImage(img, ox, oy, w, h);
    const px = x.getImageData(0, 0, S, S).data, N = S * S;
    const inp = new Float32Array(3 * N);
    for (let i = 0, j = 0; i < N; i++, j += 4) { inp[i] = px[j] / 255; inp[N + i] = px[j + 1] / 255; inp[2 * N + i] = px[j + 2] / 255; }
    const run = async s => { const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', inp, [1, 3, S, S]) }); return out[s.outputNames[0]].data; };
    let m;
    try { m = await run(session); }
    catch (e) {
      if (sessBackend !== 'WebGPU') throw e;
      console.warn('depth: WebGPU run failed, retrying on WASM', e);
      sess = await makeSession(ort, modelBytes, false); session = sess;
      m = await run(session);
    }
    // mask → alpha (slight contrast curve tidies the soft halo around hair / outlines)
    const mc = document.createElement('canvas'); mc.width = S; mc.height = S;
    const mx = mc.getContext('2d'), md = mx.createImageData(S, S), a = md.data;
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, count = 0;
    for (let i = 0; i < N; i++) {
      const v = m[i];
      const al = v <= 0.12 ? 0 : v >= 0.88 ? 1 : (v - 0.12) / 0.76;
      a[i * 4 + 3] = Math.round(al * 255);
      if (v > 0.5) {
        const X = i % S, Y = (i / S) | 0;
        if (X >= ox && X < ox + w && Y >= oy && Y < oy + h) {
          count++;
          if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
        }
      }
    }
    mx.putImageData(md, 0, 0);
    // cut-out at the image's own resolution
    const fg = document.createElement('canvas'); fg.width = w0; fg.height = h0;
    const fx = fg.getContext('2d');
    fx.drawImage(img, 0, 0, w0, h0);
    fx.globalCompositeOperation = 'destination-in';
    fx.imageSmoothingQuality = 'high';
    fx.drawImage(mc, ox, oy, w, h, 0, 0, w0, h0);
    fx.globalCompositeOperation = 'source-over';
    // bounding box + head estimate (the top quarter of the silhouette), all normalised to the image
    let box = null;
    if (count > N * 0.002) {
      const bh = y1 - y0, top = y0 + bh * 0.25;
      let sx = 0, n = 0, hx0 = 1e9, hx1 = -1;
      for (let Y = y0; Y <= top; Y++) for (let X = x0; X <= x1; X++) {
        if (m[Y * S + X] > 0.5) { sx += X; n++; if (X < hx0) hx0 = X; if (X > hx1) hx1 = X; }
      }
      const hx = n ? sx / n : (x0 + x1) / 2;
      const hy = y0 + Math.min(bh * 0.14, (hx1 - hx0) * 0.55);
      const hr = Math.max((hx1 - hx0) / 2, bh * 0.1);
      const nx = X => (X - ox) / w, ny = Y => (Y - oy) / h;
      box = { x0: nx(x0), y0: ny(y0), x1: nx(x1), y1: ny(y1), hx: nx(hx), hy: ny(hy), hr: hr / w, area: count / (w * h) };
    }
    D.src = img.src; D.fg = fg; D.box = box; D.backend = sessBackend;
    onProgress('done', 1);
    return D;
  } finally { D.busy = false; }
};

D.clear = () => { D.src = null; D.fg = null; D.box = null; };
D.ready = img => !!(img && D.fg && D.src === img.src);
})();
