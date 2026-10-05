/* ============================================================
   JIZURA — export: MP4 (WebCodecs + mp4-muxer), PNG sequence ZIP,
   file saving (artifact download capability or plain browser download)
   ============================================================ */
(() => {
'use strict';

/* ---------- saving ---------- */
J.saveFile = async (filename, data) => {
  const blob = data instanceof Blob ? data : new Blob([data]);
  try {
    if (window.claude && typeof window.claude.use === 'function') {
      const dl = await window.claude.use('downloads');
      if (dl) { await dl.save({ filename, data: blob }); return 'saved'; }
    }
  } catch (e) {
    if (e && e.code === 'declined') return 'declined';
    if (e && e.code && e.code !== 'unavailable' && e.code !== 'not_granted') throw e;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return 'saved';
};

/* ---------- codec negotiation ---------- */
J.pickVideoCodec = async (w, h, fps, bitrate, preferSoftware = false) => {
  if (typeof VideoEncoder === 'undefined') return null;
  const cands = [
    { codec: 'avc1.640033', mux: 'avc', label: 'H.264 High' },
    { codec: 'avc1.4d0033', mux: 'avc', label: 'H.264 Main' },
    { codec: 'avc1.42003e', mux: 'avc', label: 'H.264 Baseline' },
    { codec: 'vp09.00.51.08', mux: 'vp9', label: 'VP9' },
    { codec: 'av01.0.12M.08', mux: 'av1', label: 'AV1' },
  ];
  for (const c of cands) {
    const cfg = { codec: c.codec, width: w, height: h, bitrate, framerate: fps };
    if (preferSoftware) cfg.hardwareAcceleration = 'prefer-software';
    if (c.mux === 'avc') cfg.avc = { format: 'avc' };
    try { const s = await VideoEncoder.isConfigSupported(cfg); if (s.supported) return Object.assign({}, c, { cfg: s.config || cfg }); } catch (e) {}
  }
  return null;
};
J.pickAudioCodec = async (sr, chn) => {
  if (typeof AudioEncoder === 'undefined') return null;
  const rates = [48000, 44100];
  // 1. Prioritize AAC (mp4a.40.2) for universal MP4 player compatibility
  for (const r of rates) {
    try {
      const s = await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: r, numberOfChannels: 2, bitrate: 128000 });
      if (s.supported) return { codec: 'mp4a.40.2', mux: 'aac', sr: r, label: 'AAC' };
    } catch (e) {}
  }
  // 2. Fallback to Opus (note: some mobile players treat Opus in MP4 as silent)
  for (const r of rates) {
    try {
      const s = await AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate: r, numberOfChannels: 2, bitrate: 128000 });
      if (s.supported) return { codec: 'opus', mux: 'opus', sr: r, label: 'Opus' };
    } catch (e) {}
  }
  return null;
};

async function resample(buffer, sr, duration) {
  // Always upmix to 2 channels (stereo) for reliable encoder compatibility
  const chn = 2;
  const len = Math.max(1024, Math.ceil(Math.max(1, duration || 1) * sr));
  const oc = new OfflineAudioContext(chn, len, sr);
  const src = oc.createBufferSource(); src.buffer = buffer; src.connect(oc.destination); src.start(0);
  return oc.startRendering();
}

/* ---------- MP4 ---------- */
J.exportMP4 = async ({ plan, project, audio, quality = 'high', onProgress, signal }) => {
  const isMobile = J.isMobile && J.isMobile();
  const [w, h] = J.outputSize(project);
  const fps = plan.fps;
  const px = w * h * fps;
  const bitrateScale = isMobile ? (quality === 'max' ? 0.28 : quality === 'high' ? 0.18 : 0.12) : (quality === 'max' ? 0.38 : quality === 'high' ? 0.25 : 0.15);
  const bitrate = Math.round(px * bitrateScale);
  const vc = await J.pickVideoCodec(w, h, fps, bitrate);
  if (!vc) throw new Error('このブラウザは動画エンコード（WebCodecs）に対応していません。Chrome か Edge の最新版で開いてください。');
  let ac = null;
  if (audio && audio.buffer && project.includeAudio !== false) ac = await J.pickAudioCodec(48000, Math.min(2, audio.buffer.numberOfChannels));

  // If audio is requested but AudioEncoder is unavailable, delegate to MediaRecorder real-time fallback
  const wantsAudio = audio && audio.buffer && project.includeAudio !== false;
  if (wantsAudio && !ac && typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function') {
    return J.exportMP4_realtime({ plan, project, audio, quality, onProgress, signal });
  }
  
  // fastStart: false writes compressed chunks directly to target and frees chunk memory immediately,
  // preventing browser out-of-memory tab reloads on smartphones.
  const target = new Mp4Muxer.ArrayBufferTarget();
  const muxOpts = { target, video: { codec: vc.mux, width: w, height: h, frameRate: fps }, fastStart: false, firstTimestampBehavior: 'offset' };
  if (ac) muxOpts.audio = { codec: ac.mux, numberOfChannels: 2, sampleRate: ac.sr };
  const muxer = new Mp4Muxer.Muxer(muxOpts);
  let err = null;
  const venc = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: e => { console.error('VideoEncoder error:', e); err = e; }
  });
  // Do not force latencyMode: 'quality' as it causes Windows Media Foundation encoders to fail on flush
  const vencCfg = Object.assign({}, vc.cfg);
  delete vencCfg.latencyMode;
  venc.configure(vencCfg);

  if (J.glyphs && J.glyphs.clear) J.glyphs.clear();
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: false });
  const R = new J.Renderer();
  const total = Math.max(1, Math.round(plan.duration * fps));
  const scale = w / plan.W;
  const prevRes = J.glyphs.maxRes;
  J.glyphs.maxRes = isMobile ? 384 : (h >= 1000 ? 512 : 384);
  let audioIncluded = false;
  let audioNotice = '';
  let noAudioReason = '';
  if (!audio || !audio.buffer) {
    noAudioReason = '楽曲ファイルが読み込まれていません';
  } else if (project.includeAudio === false) {
    noAudioReason = '音声を含める設定がOFFになっています';
  } else if (typeof AudioEncoder === 'undefined') {
    noAudioReason = 'お使いの端末（iOS Safari等）がAudioEncoder非対応です';
  } else if (!ac) {
    noAudioReason = 'お使いのブラウザがAAC音声エンコードに対応していません';
  }
  // Pre-encode audio upfront (typically 0.1 - 0.3s) so chunks can be interleaved with video frames
  if (ac) {
    onProgress && onProgress(0.01, '音声を準備中…');
    try {
      const rs = await resample(audio.buffer, ac.sr, plan.duration);
      const chn = 2;
      let aerr = null;
      const aenc = new AudioEncoder({
        output: (chunk, meta) => {
          // Safari / Android workaround: force AAC decoderConfig if missing
          if (!meta) meta = {};
          if (!meta.decoderConfig && ac.mux === 'aac') {
            const objType = 2; // AAC-LC
            const freqIdx = ac.sr === 48000 ? 3 : (ac.sr === 44100 ? 4 : 3);
            const chanCfg = chn;
            const b1 = (objType << 3) | (freqIdx >>> 1);
            const b2 = ((freqIdx & 1) << 7) | (chanCfg << 3);
            meta.decoderConfig = {
              codec: ac.codec,
              sampleRate: ac.sr,
              numberOfChannels: chn,
              description: new Uint8Array([b1, b2])
            };
          }
          
          let duration = chunk.duration;
          if (typeof duration !== 'number' || duration < 0 || isNaN(duration)) {
            duration = 0;
          }
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          
          muxer.addAudioChunkRaw(data, chunk.type, chunk.timestamp, duration, meta);
        },
        error: e => { console.error('AudioEncoder error:', e); aerr = e; }
      });
      aenc.configure({ codec: ac.codec, sampleRate: ac.sr, numberOfChannels: chn, bitrate: 128000 });
      // Opus uses 960 sample frames (20ms at 48kHz); AAC uses 1024 sample frames
      const frameUnit = ac.mux === 'opus' ? 960 : 1024;
      const block = frameUnit * 4;
      const frames = rs.length;
      const maxPadFrames = block + frameUnit;
      const dataBuffer = new Float32Array(maxPadFrames * chn);
      for (let off = 0; off < frames; off += block) {
        if (aerr) throw aerr;
        const n = Math.min(block, frames - off);
        const padFrames = (n % frameUnit === 0) ? n : Math.ceil(n / frameUnit) * frameUnit;
        dataBuffer.fill(0, 0, padFrames * chn);
        for (let c = 0; c < chn; c++) {
          dataBuffer.set(rs.getChannelData(c).subarray(off, off + n), c * padFrames);
        }
        const frameData = dataBuffer.subarray(0, padFrames * chn);
        const ad = new AudioData({
          format: 'f32-planar',
          sampleRate: ac.sr,
          numberOfFrames: padFrames,
          numberOfChannels: chn,
          timestamp: Math.round(off * 1e6 / ac.sr),
          data: frameData
        });
        aenc.encode(ad);
        ad.close();
        while (aenc.encodeQueueSize > (isMobile ? 3 : 8)) {
          if (aerr) throw aerr;
          await new Promise(r => setTimeout(r, 4));
        }
      }
      while (aenc.encodeQueueSize > 0) {
        if (aerr) throw aerr;
        await new Promise(r => setTimeout(r, 10));
      }
      const flushPromise = aenc.flush();
      const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error('Audio flush timeout')), 25000));
      await Promise.race([flushPromise, timeoutPromise]);
      try { aenc.close(); } catch (e) {}
      if (aerr) throw aerr;
      audioIncluded = audioChunks.length > 0;
    } catch (audioErr) {
      console.warn('Audio pre-encode failed, proceeding without audio:', audioErr);
      audioNotice = '（音声エンコード失敗: ' + (audioErr.message || audioErr) + '）';
      noAudioReason = '音声エンコードエラー: ' + (audioErr.message || audioErr);
      audioIncluded = false;
    }
  }

  try {
    // 速度向上のため、PCの場合はエンコーダのキューサイズを増やして並列度を上げる
    const maxVencQueue = isMobile ? 2 : 16;
    for (let i = 0; i < total; i++) {
      if (signal && signal.aborted) { try { venc.close(); } catch (e) {} throw new Error('キャンセルしました'); }
      if (err) throw err;
      const curTime = i / fps;
      R.frame(ctx, plan, curTime, { scale });
      const vf = new VideoFrame(canvas, { timestamp: Math.round(curTime * 1e6), duration: Math.round(1e6 / fps) });
      venc.encode(vf, { keyFrame: i % (fps * 2) === 0 });
      vf.close();

      // audio is already added

      while (venc.encodeQueueSize > maxVencQueue) {
        if (err) throw err;
        await new Promise(r => setTimeout(r, 2));
      }
      // PCでのsetTimeout(0)呼び出しオーバーヘッドを減らすため、更新頻度を3フレームから15フレームに間引く
      if (i % (isMobile ? 2 : 15) === 0 || i === total - 1) {
        onProgress && onProgress((i + 1) / total * 0.95, `映像フレーム ${i + 1}/${total}`);
        // Yield execution to allow mobile browser garbage collection
        await new Promise(r => setTimeout(r, isMobile ? 4 : 0));
      }
    }
  } finally {
    J.glyphs.maxRes = prevRes;
    // Release drawing canvas memory immediately
    canvas.width = 1; canvas.height = 1;
  }

  onProgress && onProgress(0.96, '映像を完了処理中…');
  while (venc.encodeQueueSize > 0) {
    if (err) throw err;
    await new Promise(r => setTimeout(r, 15));
  }
  try {
    await venc.flush();
  } catch (flushErr) {
    console.error('venc.flush() error:', flushErr);
    if (!err) err = flushErr;
  }
  try { venc.close(); } catch (e) {}
  if (err) throw err;

  onProgress && onProgress(0.99, 'MP4コンテナを出力中…');
  muxer.finalize();
  if (J.glyphs && J.glyphs.clear) J.glyphs.clear();
  onProgress && onProgress(1, '完了');
  return {
    blob: new Blob([target.buffer], { type: 'video/mp4' }),
    codec: vc.label,
    audio: audioIncluded ? ac.mux : null,
    audioLabel: audioIncluded ? (ac.label || ac.mux.toUpperCase()) : null,
    notice: audioNotice,
    noAudioReason: audioIncluded ? '' : noAudioReason,
    width: w,
    height: h
  };
};

/* ---------- MediaRecorder fallback for mobile (real-time recording with audio) ---------- */
J.exportMP4_realtime = async ({ plan, project, audio, quality = 'high', onProgress, signal }) => {
  if (typeof MediaRecorder === 'undefined') throw new Error('MediaRecorderに非対応です');
  const [w, h] = J.outputSize(project);
  const fps = plan.fps;
  const duration = plan.duration;
  const total = Math.max(1, Math.round(duration * fps));
  const scale = w / plan.W;

  // Canvas + renderer setup
  if (J.glyphs && J.glyphs.clear) J.glyphs.clear();
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: false });
  const R = new J.Renderer();
  const prevRes = J.glyphs.maxRes;
  J.glyphs.maxRes = 384;

  // Render first frame before starting capture (so stream has initial content)
  R.frame(ctx, plan, 0, { scale });

  // Video stream from canvas — automatic capture at fps
  const videoStream = canvas.captureStream(fps);

  // Audio stream via Web Audio → MediaStreamDestination
  let audioCtx, audioDest, audioSrc;
  let audioIncluded = false;
  let combinedStream = videoStream;
  const hasAudioSource = audio && audio.buffer && project.includeAudio !== false;

  if (hasAudioSource) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      audioDest = audioCtx.createMediaStreamDestination();
      combinedStream = new MediaStream([
        ...videoStream.getVideoTracks(),
        ...audioDest.stream.getAudioTracks()
      ]);
      audioIncluded = true;
    } catch (e) {
      console.warn('Audio stream setup failed:', e);
      combinedStream = videoStream;
    }
  }

  // Choose codec — prefer MP4 (Safari), fall back to WebM (Chrome Android)
  const px = w * h * fps;
  const bitrateScale = quality === 'max' ? 0.28 : quality === 'high' ? 0.18 : 0.12;
  const bitrate = Math.round(px * bitrateScale);
  let mimeType = '';
  for (const mt of [
    'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
    'video/mp4; codecs="avc1.42E01E"',
    'video/mp4',
    'video/webm; codecs="vp9,opus"',
    'video/webm; codecs="vp8,opus"',
    'video/webm'
  ]) {
    if (MediaRecorder.isTypeSupported(mt)) { mimeType = mt; break; }
  }
  if (!mimeType) throw new Error('対応する動画形式が見つかりません');
  const isMP4 = mimeType.startsWith('video/mp4');

  const chunks = [];
  const recOpts = { mimeType, videoBitsPerSecond: bitrate };
  if (audioIncluded) recOpts.audioBitsPerSecond = 128000;
  const recorder = new MediaRecorder(combinedStream, recOpts);
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

  // WakeLock — prevent screen dimming during real-time recording
  let wakeLock = null;
  if ('wakeLock' in navigator) {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* non-critical */ }
  }

  return new Promise((resolve, reject) => {
    let stopped = false;
    const cleanup = () => {
      J.glyphs.maxRes = prevRes;
      canvas.width = 1; canvas.height = 1;
      if (audioCtx) try { audioCtx.close(); } catch (e) {}
      if (J.glyphs && J.glyphs.clear) J.glyphs.clear();
      if (wakeLock) try { wakeLock.release(); } catch (e) {}
    };

    if (signal) signal.addEventListener('abort', () => {
      stopped = true;
      if (audioSrc) try { audioSrc.stop(); } catch (e) {}
      try { recorder.stop(); } catch (e) {}
      cleanup();
      reject(new Error('キャンセルしました'));
    }, { once: true });

    recorder.onerror = e => { stopped = true; cleanup(); reject(e.error || e); };
    recorder.onstop = () => {
      cleanup();
      const blob = new Blob(chunks, { type: isMP4 ? 'video/mp4' : 'video/webm' });
      onProgress && onProgress(1, '完了');
      resolve({
        blob,
        ext: isMP4 ? 'mp4' : 'webm',
        codec: (isMP4 ? 'H.264' : 'VP9') + ' (リアルタイム録画)',
        audio: audioIncluded ? (isMP4 ? 'aac' : 'opus') : null,
        audioLabel: audioIncluded ? (isMP4 ? 'AAC' : 'Opus') : null,
        notice: '',
        noAudioReason: audioIncluded ? '' : (hasAudioSource ? '音声ストリーム作成失敗' : '楽曲ファイルが読み込まれていません'),
        width: w, height: h
      });
    };

    // Start recording
    recorder.start(1000);

    // Start audio playback into MediaStreamDestination
    if (audioIncluded && audioCtx) {
      if (audioCtx.state === 'suspended') audioCtx.resume();
      audioSrc = audioCtx.createBufferSource();
      audioSrc.buffer = audio.buffer;
      audioSrc.connect(audioDest);
      audioSrc.start(0);
    }

    // Real-time rendering loop — render at actual wall-clock time
    const startTime = performance.now();
    let lastFrame = -1;

    function loop() {
      if (stopped) return;
      const elapsed = (performance.now() - startTime) / 1000;
      const targetFrame = Math.min(Math.floor(elapsed * fps), total - 1);

      if (targetFrame > lastFrame) {
        R.frame(ctx, plan, targetFrame / fps, { scale });
        lastFrame = targetFrame;
        const elapsedS = Math.floor(elapsed);
        const totalS = Math.ceil(duration);
        onProgress && onProgress((targetFrame / total) * 0.98, `リアルタイム録画中… ${elapsedS}秒 / ${totalS}秒`);
      }

      if (elapsed < duration + 0.05) {
        requestAnimationFrame(loop);
      } else {
        // Render final frame
        if (lastFrame < total - 1) R.frame(ctx, plan, (total - 1) / fps, { scale });
        onProgress && onProgress(0.99, '録画を終了中…');
        if (audioSrc) try { audioSrc.stop(); } catch (e) {}
        // Short delay to ensure MediaRecorder captures final data
        setTimeout(() => {
          if (!stopped) { stopped = true; try { recorder.stop(); } catch (e) {} }
        }, 500);
      }
    }
    requestAnimationFrame(loop);
  });
};

/* ---------- PNG sequence as ZIP (store, no compression) ---------- */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (u8) => { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
class ZipWriter {
  constructor() { this.parts = []; this.central = []; this.offset = 0; }
  add(name, u8) {
    const nb = new TextEncoder().encode(name), crc = crc32(u8);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, 0, true); lh.setUint16(12, 0x21, true); lh.setUint32(14, crc, true); lh.setUint32(18, u8.length, true); lh.setUint32(22, u8.length, true);
    lh.setUint16(26, nb.length, true); lh.setUint16(28, 0, true);
    this.parts.push(lh.buffer, nb, u8);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, 0, true); ch.setUint16(14, 0x21, true); ch.setUint32(16, crc, true); ch.setUint32(20, u8.length, true); ch.setUint32(24, u8.length, true);
    ch.setUint16(28, nb.length, true); ch.setUint32(42, this.offset, true);
    this.central.push(ch.buffer, nb);
    this.offset += 30 + nb.length + u8.length;
  }
  finish() {
    const cdSize = this.central.reduce((s, p) => s + (p.byteLength ?? p.length), 0);
    const n = this.central.length / 2;
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, n, true); end.setUint16(10, n, true); end.setUint32(12, cdSize, true); end.setUint32(16, this.offset, true);
    return new Blob([...this.parts, ...this.central, end.buffer], { type: 'application/zip' });
  }
}
/* layers: transparent PNGs in two folders — back/ (background graphic + decorations behind the lyrics) and front/
   (lyrics, their decorations, ghosts, HUD). Screen effects are applied to both, so stacking front over back matches. */
J.exportPNGZip = async ({ plan, project, transparent, layers, onProgress, signal, every = 1 }) => {
  const [w, h] = J.outputSize(project);
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const R = new J.Renderer();
  const fps = plan.fps, total = Math.max(1, Math.round(plan.duration * fps));
  const zip = new ZipWriter();
  const scale = w / plan.W;
  for (let i = 0; i < total; i += every) {
    if (signal && signal.aborted) throw new Error('キャンセルしました');
    const name = `jizura_${String(i).padStart(5, '0')}.png`;
    for (const layer of layers ? ['back', 'front'] : [null]) {
      R.frame(ctx, plan, i / fps, { scale, transparent: transparent || !!layers, layer });
      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      zip.add((layer ? layer + '/' : '') + name, new Uint8Array(await blob.arrayBuffer()));
    }
    onProgress && onProgress(i / total, `PNG ${i + 1}/${total}`);
  }
  onProgress && onProgress(1, '完了');
  return zip.finish();
};

/* ---------- plan JSON for the After Effects panel ---------- */
/* The After Effects panel implements the original expression set. Newer pack entries are exported as their
   closest original counterpart (the browser key is kept in web* fields so nothing is lost). */
J.AE_MAP = {
  layout: { lowerThird: 'center', corners: 'mixed', staircase: 'mixed', zigzag: 'wave', arcTop: 'ring', spiral: 'ring', gridCells: 'labels', dropCap: 'mixed', justified: 'tile', frameBox: 'center', bubble: 'pill', subtitleBar: 'center', ticker: 'marquee', splitScreen: 'diag', mirror: 'stack', sideways: 'vcols', edgeFrame: 'marquee', perspective: 'stack', hanko: 'vcols', genkou: 'vcols', panels: 'diag', filmstrip: 'labels', quote: 'center', ruler: 'gloss', searchBar: 'type', chat: 'labels', notification: 'pill', ticket: 'pill',
    rain: 'tile', hanging: 'scatter', orbit: 'ring', tunnel: 'tile', wordCloud: 'scatter', bounceLine: 'mixed', elastic: 'condensed', crossBands: 'diag', stickerBomb: 'labels', neon: 'center', keycaps: 'labels', bubbles: 'scatter', slotMachine: 'labels', flipBoard: 'labels', credits: 'type', zoomRepeat: 'stack', splitHalves: 'stack', columnsBig: 'vcols', circleWords: 'ring', dotMatrix: 'type', depthStack: 'stack', typeSpecimen: 'stack', kanjiFocus: 'huge', halfVertical: 'vcols', curtain: 'center', equalizer: 'mixed', tape: 'diag' },
  enter: { riseMask: 'drop', dropMask: 'drop', slideL: 'wipe', slideR: 'wipe', slideWhole: 'stretch', flipX: 'spin', flipY: 'spin', domino: 'spin', fold: 'pop', unroll: 'wipe', strokeDraw: 'assemble', outlineFill: 'blur', splitJoin: 'slice', vSlice: 'slice', shutter: 'wipe', iris: 'zoom', diagWipe: 'wipe', blinds: 'slice', checker: 'flicker', randomOrder: 'flicker', bounceBig: 'drop', squashDrop: 'drop', rubber: 'stretch', glitchIn: 'scramble', echoIn: 'zoom', whip: 'stretch', skewIn: 'stretch', trackIn: 'blur', trackOut: 'blur', blurStagger: 'blur', fadeStagger: 'blur', waveIn: 'pop', spiralIn: 'spin', zoomOut: 'zoom', resolve: 'scramble', magnet: 'assemble', inkBleed: 'blur', neonOn: 'flicker', cursorSweep: 'type', stamp: 'zoom' },
  exit: { sinkMask: 'fall', riseOut: 'drift', slideOutL: 'stretch', slideOutR: 'stretch', flipOutX: 'shrink', flipOutY: 'fall', foldOut: 'shrink', squash: 'shrink', trackOutWide: 'blur', collapse: 'shrink', zoomThrough: 'blur', zoomFar: 'shrink', spinOut: 'scatter', twist: 'shrink', waveOut: 'scatter', blurOutStagger: 'blur', undraw: 'blur', outlineOut: 'blur', irisClose: 'shrink', diagWipeOut: 'wipe', blindsClose: 'slice', checkerOut: 'glitch', splitApart: 'slice', vSliceDrop: 'fall', melt: 'fall', dissolve: 'drift', backspace: 'wipe', scrambleOut: 'glitch', glitchDissolve: 'glitch', echoOut: 'blur', whipOut: 'stretch', gravity: 'fall', popOut: 'scatter', burn: 'drift', sweepCover: 'wipe', shatterLite: 'explode' },
  hold: { float: 'drift', sway: 'wave', pulse: 'breathe', shimmer: 'still', colorRun: 'still', rotateSlow: 'drift', trackBreathe: 'breathe', skewWobble: 'wave', beatHop: 'wave', hWave: 'wave', heartbeat: 'breathe', orbitSmall: 'jitter', jelly: 'breathe', scanBand: 'glitchtick', noiseDrift: 'drift', tilt: 'drift', zoomSlow: 'drift', stretchPulse: 'breathe', glitchJump: 'glitchtick', echoTrail: 'drift' },
  decor: { crosshair: 'brackets', cropMarks: 'brackets', reticle: 'rings', radar: 'rings', progressRing: 'rings', timecodeBar: 'barcode', rulerEdge: 'grid', dimension: 'leaders', indexNum: 'counter', dateStamp: 'barcode', qrBlock: 'barcode', glitchRects: 'bars', concentricSquares: 'shapes', triangleSpin: 'shapes', lineBurst: 'sparks', plusGrid: 'grid', guides: 'grid', waveLine: 'waveform', spiralLine: 'rings', halftonePatch: 'shapes', checkerStrip: 'stripes', beatRing: 'rings', orbitDots: 'dots', constellation: 'sparks', confetti: 'shapes', petals: 'shapes', rainStreaks: 'slash', snow: 'dots', lightLeak: 'blobs', bokeh: 'blobs', speedCorner: 'slash', risingParticles: 'sparks', twinkle: 'sparks', brushStroke: 'bars', tapePieces: 'bars', scribbleCircle: 'rings', scribbleUnder: 'slash', crossOut: 'slash', highlightMark: 'bars', heartsStars: 'shapes', watermarkKanji: 'counter', verticalStrip: 'leaders', romajiLine: 'leaders', bracketsJP: 'brackets', seal: 'shapes' },
  fx: { rgbSplit: 'chroma', smear: 'slice', vhsRoll: 'slice', trackingNoise: 'slice', waveWarp: 'slice', pixelDrift: 'slice', tileShift: 'block', gridRepeat: 'block', mirrorFlash: 'block', strobe: 'invert', blackFrame: 'invert', whiteFrame: 'flash', filmBurn: 'flash', lightSweep: 'flash', panelWipe: 'flash', zoomPunch: 'zoom', whipBlur: 'zoom', posterize: 'mosaic', hueShift: 'chroma', irisTrans: 'zoom', doors: 'slice', blindsTrans: 'slice', splitSlide: 'slice', crtOff: 'flash' },
};
// The plan goes to the After Effects panel as-is (version 2): the panel builds every key it implements and
// picks the closest counterpart itself (from the exported metadata / J.AE_MAP) for anything it lacks.
J.planForAE = (plan, project) => {
  const clean = JSON.parse(JSON.stringify(plan, (k, v) => (k === 'energy' || k === 'buffer' || k === 'peaks' ? undefined : v)));
  clean.version = 2;
  clean.width = J.outputSize(project)[0]; clean.height = J.outputSize(project)[1];
  clean.extra = project.extra === true; clean.wa = project.wa !== false;
  clean.fonts = {};
  for (const [role, keys] of Object.entries(plan.style.fonts)) clean.fonts[role] = keys.map(k => J.FONTS[k] ? J.FONTS[k].label : k);
  clean.fontTable = Object.fromEntries(Object.entries(J.FONTS).map(([k, f]) => [k, { label: f.label, family: f.family.replace(/"/g, ''), weight: f.weight, kind: f.kind }]));
  // lyric language: the face each key is drawn with in the browser for this plan (the panel maps keys → AE fonts per language)
  clean.lang = plan.lang || 'ja';
  if (J.setLang && J.faceOf && clean.lang !== 'ja') {
    J.setLang(clean.lang);
    for (const k of Object.keys(clean.fontTable)) { const f = J.faceOf(k); clean.fontTable[k].langFamily = f.family.replace(/"/g, ''); clean.fontTable[k].langWeight = f.weight; }
  }
  return clean;
};
})();
