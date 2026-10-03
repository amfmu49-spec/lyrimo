/* ============================================================
   JIZURA — キャラ・人物自動切り抜き (Background AI Removal)
   Runs 100% locally in the browser using onnxruntime-web + U2-Net Portrait (u2netp).
   Ultra-fast, lightweight (4.6MB), privacy-safe (the image never leaves the device).
   The model is cached locally in Cache Storage after the first download.
   ============================================================ */
(() => {
'use strict';
const ORT_DIR = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
const ORT_URL = ORT_DIR + 'ort.wasm.min.js';
const MODEL_URLS = [
  'https://huggingface.co/facefusion/models-3.5.0/resolve/main/u2netp.onnx',
  'https://huggingface.co/chwshuang/Stable_diffusion_remove_background_model/resolve/main/u2netp.onnx'
];
const MODEL_SIZE = 4603750;
const CACHE_NAME = 'lyrimo-models-v1';
const S = 320; // u2netp input resolution: 1x3x320x320

/* cover-fit rect of an iw x ih image inside W x H */
J.coverRect = (iw, ih, W, H) => {
  const k = Math.max(W / Math.max(1, iw), H / Math.max(1, ih));
  const w = iw * k, h = ih * k;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
};

const D = J.depth = { src: null, fg: null, box: null, busy: false, backend: null };
let ortP = null, sess = null;

function loadOrt() {
  if (window.ort && window.ort.InferenceSession) return Promise.resolve(window.ort);
  return ortP || (ortP = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = ORT_URL; s.crossOrigin = 'anonymous'; s.async = true;
    s.onload = () => {
      const ort = window.ort;
      if (!ort || !ort.InferenceSession) { ortP = null; rej(new Error('AIエンジンを初期化できませんでした')); return; }
      ort.env.wasm.wasmPaths = ORT_DIR;
      ort.env.wasm.numThreads = 1;
      res(ort);
    };
    s.onerror = () => { ortP = null; rej(new Error('AIエンジンのスクリプトを読み込めませんでした')); };
    document.head.appendChild(s);
  }));
}

async function fetchModel(onProgress) {
  let cache = null;
  try {
    cache = await caches.open(CACHE_NAME);
    for (const url of MODEL_URLS) {
      const hit = await cache.match(url);
      if (hit) {
        const b = new Uint8Array(await hit.arrayBuffer());
        if (b.length > 1e6) { onProgress('model', 1); return b; }
      }
    }
  } catch (e) { cache = null; }

  let lastErr = null;
  for (const url of MODEL_URLS) {
    try {
      const r = await fetch(url, { mode: 'cors' });
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
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
      if (cache) {
        try { await cache.put(url, new Response(buf.slice(), { headers: { 'content-type': 'application/octet-stream' } })); } catch (e) {}
      }
      onProgress('model', 1);
      return buf;
    } catch (err) {
      lastErr = err;
      console.warn('AI model fetch failed on', url, err);
    }
  }
  throw new Error(`AIモデルのダウンロードに失敗しました: ${lastErr?.message || 'ネットワークエラー'}`);
}

async function getSession(onProgress) {
  if (sess) return sess;
  onProgress('engine', 0);
  const ort = await loadOrt();
  const modelBytes = await fetchModel(onProgress);
  onProgress('init', 0);
  sess = await ort.InferenceSession.create(modelBytes, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all'
  });
  D.backend = 'WASM';
  return sess;
}

/* Run background removal on an <img>; builds D.fg (character cutout) and D.box */
D.detect = async (img, onProgress = () => {}) => {
  if (!img || !img.naturalWidth) throw new Error('背景画像がまだ読み込まれていません');
  if (D.src === img.src && D.fg) return D;
  if (D.busy) throw new Error('検出中です');
  D.busy = true;

  try {
    const session = await getSession(onProgress);
    onProgress('run', 0);

    const w0 = img.naturalWidth, h0 = img.naturalHeight;
    // Prepare 320x320 letterboxed input
    let w, h;
    if (h0 > w0) { h = S; w = Math.max(1, Math.round(S * w0 / h0)); }
    else { w = S; h = Math.max(1, Math.round(S * h0 / w0)); }
    const ox = (S - w) >> 1, oy = (S - h) >> 1;

    const c = document.createElement('canvas'); c.width = S; c.height = S;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.fillStyle = '#000'; x.fillRect(0, 0, S, S);
    x.imageSmoothingQuality = 'high';
    x.drawImage(img, ox, oy, w, h);

    const px = x.getImageData(0, 0, S, S).data, N = S * S;
    const inp = new Float32Array(3 * N);
    // Standard ImageNet normalization for U2Net
    for (let i = 0, j = 0; i < N; i++, j += 4) {
      inp[i] = (px[j] / 255 - 0.485) / 0.229;
      inp[N + i] = (px[j + 1] / 255 - 0.456) / 0.224;
      inp[2 * N + i] = (px[j + 2] / 255 - 0.406) / 0.225;
    }

    const inputTensor = new ort.Tensor('float32', inp, [1, 3, S, S]);
    const out = await session.run({ [session.inputNames[0]]: inputTensor });
    const m = out[session.outputNames[0]].data;

    // Normalise mask
    let minV = 1e9, maxV = -1e9;
    for (let i = 0; i < N; i++) {
      const v = m[i];
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const range = maxV - minV || 1;

    const mc = document.createElement('canvas'); mc.width = S; mc.height = S;
    const mx = mc.getContext('2d'), md = mx.createImageData(S, S), a = md.data;
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, count = 0;

    for (let i = 0; i < N; i++) {
      const norm = (m[i] - minV) / range;
      // Soft threshold curve for hair & outline edges
      const al = norm <= 0.16 ? 0 : norm >= 0.84 ? 1 : (norm - 0.16) / 0.68;
      a[i * 4 + 3] = Math.round(al * 255);
      if (norm > 0.45) {
        const X = i % S, Y = (i / S) | 0;
        if (X >= ox && X < ox + w && Y >= oy && Y < oy + h) {
          count++;
          if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
        }
      }
    }
    mx.putImageData(md, 0, 0);

    // Cut-out at original image's native resolution
    const fg = document.createElement('canvas'); fg.width = w0; fg.height = h0;
    const fx = fg.getContext('2d');
    fx.drawImage(img, 0, 0, w0, h0);
    fx.globalCompositeOperation = 'destination-in';
    fx.imageSmoothingQuality = 'high';
    fx.drawImage(mc, ox, oy, w, h, 0, 0, w0, h0);
    fx.globalCompositeOperation = 'source-over';

    // Bounding box estimation
    let box = null;
    if (count > N * 0.002) {
      const nx = X => (X - ox) / w, ny = Y => (Y - oy) / h;
      box = {
        x0: nx(x0), y0: ny(y0), x1: nx(x1), y1: ny(y1),
        hx: nx((x0 + x1) / 2), hy: ny(y0 + (y1 - y0) * 0.25),
        hr: Math.max((x1 - x0) / 2, (y1 - y0) * 0.1) / w,
        area: count / (w * h)
      };
    }

    D.src = img.src; D.fg = fg; D.box = box;
    onProgress('done', 1);
    return D;
  } finally {
    D.busy = false;
  }
};

D.clear = () => { D.src = null; D.fg = null; D.box = null; };
D.ready = img => !!(img && D.fg && D.src === img.src);
})();
