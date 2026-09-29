(function(){
  (async function(){
    const VER = "v1.0.0";
    
    function cleanText(t) {
      return (t || "").replace(/\r/g, "").replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").trim();
    }
    
    function isSectionTag(t) {
      let s = cleanText(t);
      return /^\[.*\]$/.test(s) || /^\(.*\)$/.test(s) || /^\uFF08.*\uFF09$/.test(s) || /^【.*】$/.test(s);
    }
    
    function formatSrtTime(ms) {
      let s = ms / 1000;
      let h = Math.floor(s / 3600);
      let m = Math.floor((s % 3600) / 60);
      let sec = Math.floor(s % 60);
      let milli = Math.floor(ms % 1000);
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(milli).padStart(3, '0')}`;
    }
    
    function formatLrcTime(ms) {
      let s = ms / 1000;
      let m = Math.floor(s / 60);
      let sec = Math.floor(s % 60);
      let centi = Math.floor((ms % 1000) / 10);
      return `[${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(centi).padStart(2, '0')}]`;
    }

    // 1. 曲IDの取得
    let songId = null;
    let pm = window.location.pathname.match(/\/song-detail\/([0-9a-zA-Z_\-]+)/i);
    if (pm) {
      songId = pm[1];
    } else {
      let sp = new URLSearchParams(window.location.search);
      songId = sp.get("song_id") || sp.get("id");
    }
    
    let songTitle = "";
    let audioUrl = "";
    let rowsData = []; // { start_ms, end_ms, text }

    // 2. window.__INITIAL_STATE__ からデータ抽出
    try {
      let state = window.__INITIAL_STATE__;
      let info = state?.storeDetailStoreData?.info;
      if (info) {
        if (!songId && info.song_id) songId = String(info.song_id);
        if (String(info.song_id) === String(songId) || !songId) {
          songTitle = info.title || "";
          if (info.mp3_url) {
            audioUrl = info.mp3_url.startsWith("http") ? info.mp3_url : "https://static-cos.mureka.ai/" + info.mp3_url.replace(/^\/+/, "");
          } else if (info.song_url) {
            audioUrl = info.song_url.startsWith("http") ? info.song_url : "https://static-cos.mureka.ai/" + info.song_url.replace(/^\/+/, "");
          }
          if (Array.isArray(info.lyrics) && info.lyrics.length > 0) {
            for (let sec of info.lyrics) {
              if (Array.isArray(sec.rows)) {
                for (let r of sec.rows) {
                  let txt = cleanText(r.text);
                  if (txt && !isSectionTag(txt)) {
                    rowsData.push({
                      start_ms: Number(r.start) || 0,
                      end_ms: Number(r.end) || (Number(r.start) + 3000),
                      text: txt
                    });
                  }
                }
              }
            }
          }
        }
      }
    } catch(e) {
      console.warn("[Mureka BM] initial state read error:", e);
    }

    // 3. もしAPIでフェッチが必要な場合（SPA遷移等でinitial stateにない場合）
    if (rowsData.length === 0 && songId) {
      try {
        let res = await fetch(`/api/pgc/song/info?song_id=${songId}`, { credentials: 'include' });
        if (res.ok) {
          let json = await res.json();
          let d = json.data || json;
          if (d) {
            if (!songTitle && d.title) songTitle = d.title;
            if (!audioUrl && d.mp3_url) {
              audioUrl = d.mp3_url.startsWith("http") ? d.mp3_url : "https://static-cos.mureka.ai/" + d.mp3_url.replace(/^\/+/, "");
            }
            if (Array.isArray(d.lyrics)) {
              for (let sec of d.lyrics) {
                if (Array.isArray(sec.rows)) {
                  for (let r of sec.rows) {
                    let txt = cleanText(r.text);
                    if (txt && !isSectionTag(txt)) {
                      rowsData.push({
                        start_ms: Number(r.start) || 0,
                        end_ms: Number(r.end) || (Number(r.start) + 3000),
                        text: txt
                      });
                    }
                  }
                }
              }
            }
          }
        }
      } catch(e) {
        console.warn("[Mureka BM] api fetch error:", e);
      }
    }

    // 4. 音声フォールバック
    if (!audioUrl) {
      let audioEl = document.querySelector('audio[src*="cos.mureka.ai"], audio[src*=".mp3"]');
      if (audioEl && audioEl.src) audioUrl = audioEl.src;
    }
    if (!songTitle) {
      let h1 = document.querySelector('h1.title, .title-wrapper-detail h1');
      if (h1) songTitle = cleanText(h1.textContent);
    }

    // 5. DOMからの歌詞フォールバック
    if (rowsData.length === 0) {
      let lineEls = document.querySelectorAll('.lyrics .line, .lyricBlock .line');
      let lines = [];
      lineEls.forEach(el => {
        let t = cleanText(el.textContent);
        if (t && !isSectionTag(t)) lines.push(t);
      });
      if (lines.length > 0) {
        let totalDurationMs = 60000;
        let step = totalDurationMs / lines.length;
        rowsData = lines.map((txt, idx) => ({
          start_ms: Math.floor(idx * step),
          end_ms: Math.floor((idx + 1) * step),
          text: txt
        }));
      }
    }

    if (rowsData.length === 0) {
      alert(`[${VER}] Murekaの歌詞データを取得できませんでした。\n楽曲詳細ページ (mureka.ai/song-detail/...) を開いてから実行してください。`);
      return;
    }

    // 6. SRT / LRC 文字列生成
    let currentFormat = "srt";
    function getFormattedText() {
      if (currentFormat === "srt") {
        return rowsData.map((r, i) => `${i + 1}\n${formatSrtTime(r.start_ms)} --> ${formatSrtTime(r.end_ms)}\n${r.text}\n`).join("\n");
      } else {
        return rowsData.map(r => `${formatLrcTime(r.start_ms)}${r.text}`).join("\n");
      }
    }

    // 7. モーダルUIの表示
    let oldOverlay = document.getElementById("mureka-lrc-bm-overlay");
    if (oldOverlay) oldOverlay.remove();

    let overlay = document.createElement("div");
    overlay.id = "mureka-lrc-bm-overlay";
    Object.assign(overlay.style, {
      position: "fixed",
      top: "0",
      left: "0",
      width: "100vw",
      height: "100vh",
      backgroundColor: "rgba(0, 0, 0, 0.85)",
      zIndex: "999999",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "system-ui, -apple-system, sans-serif",
      padding: "20px",
      boxSizing: "border-box"
    });

    let box = document.createElement("div");
    Object.assign(box.style, {
      background: "#18181b",
      padding: "24px",
      borderRadius: "16px",
      width: "100%",
      maxWidth: "520px",
      boxShadow: "0 10px 30px rgba(0, 0, 0, 0.7)",
      display: "flex",
      flexDirection: "column",
      gap: "16px",
      border: "1px solid #27272a"
    });

    let header = document.createElement("div");
    header.style.display = "flex";
    header.style.justifyContent = "space-between";
    header.style.alignItems = "center";

    let titleBox = document.createElement("div");
    let title = document.createElement("h2");
    title.textContent = `🎶 Mureka Export (${VER})`;
    Object.assign(title.style, { margin: "0", color: "#fff", fontSize: "18px" });
    let sub = document.createElement("div");
    sub.textContent = songTitle ? `🎵 ${songTitle}` : (songId ? `ID: ${songId}` : "");
    Object.assign(sub.style, { color: "#a1a1aa", fontSize: "12px", marginTop: "4px" });
    titleBox.appendChild(title);
    if (sub.textContent) titleBox.appendChild(sub);
    header.appendChild(titleBox);

    let formatSwitch = document.createElement("div");
    formatSwitch.style.display = "flex";
    formatSwitch.style.gap = "4px";
    let srtBtn = document.createElement("button");
    srtBtn.textContent = "SRT";
    let lrcBtn = document.createElement("button");
    lrcBtn.textContent = "LRC";
    
    function updateFormatStyles() {
      let activeStyle = { background: "#6366f1", color: "#fff", border: "none", borderRadius: "6px", padding: "4px 10px", fontSize: "12px", fontWeight: "bold", cursor: "pointer" };
      let inactiveStyle = { background: "#27272a", color: "#a1a1aa", border: "none", borderRadius: "6px", padding: "4px 10px", fontSize: "12px", cursor: "pointer" };
      Object.assign(srtBtn.style, currentFormat === "srt" ? activeStyle : inactiveStyle);
      Object.assign(lrcBtn.style, currentFormat === "lrc" ? activeStyle : inactiveStyle);
      textarea.value = getFormattedText();
    }
    srtBtn.onclick = () => { currentFormat = "srt"; updateFormatStyles(); };
    lrcBtn.onclick = () => { currentFormat = "lrc"; updateFormatStyles(); };
    formatSwitch.appendChild(srtBtn);
    formatSwitch.appendChild(lrcBtn);
    header.appendChild(formatSwitch);
    box.appendChild(header);

    let textarea = document.createElement("textarea");
    textarea.value = getFormattedText();
    textarea.readOnly = false;
    Object.assign(textarea.style, {
      width: "100%",
      height: "220px",
      backgroundColor: "#09090b",
      color: "#22c55e",
      border: "1px solid #27272a",
      borderRadius: "8px",
      padding: "12px",
      boxSizing: "border-box",
      fontFamily: "monospace",
      fontSize: "12px",
      resize: "none"
    });
    box.appendChild(textarea);
    updateFormatStyles();

    let btnRow = document.createElement("div");
    btnRow.style.display = "flex";
    btnRow.style.gap = "8px";
    btnRow.style.flexWrap = "wrap";

    // コピー
    let copyBtn = document.createElement("button");
    copyBtn.textContent = "📋 コピー";
    Object.assign(copyBtn.style, {
      flex: "1",
      minWidth: "90px",
      padding: "10px",
      background: "#3f3f46",
      color: "#fff",
      border: "none",
      borderRadius: "8px",
      fontWeight: "bold",
      cursor: "pointer"
    });
    copyBtn.onclick = async () => {
      await navigator.clipboard.writeText(textarea.value);
      copyBtn.textContent = "✅ コピー完了!";
      setTimeout(() => copyBtn.textContent = "📋 コピー", 2000);
    };

    // ダウンロード
    let dlBtn = document.createElement("button");
    dlBtn.textContent = "⬇️ Download";
    Object.assign(dlBtn.style, {
      flex: "1",
      minWidth: "110px",
      padding: "10px",
      background: "#2563eb",
      color: "#fff",
      border: "none",
      borderRadius: "8px",
      fontWeight: "bold",
      cursor: "pointer"
    });
    dlBtn.onclick = () => {
      let blob = new Blob([textarea.value], { type: "text/plain" });
      let url = URL.createObjectURL(blob);
      let a = document.createElement("a");
      a.href = url;
      let safeTitle = (songTitle || songId || "mureka").replace(/[/\\?%*:|"<>]/g, "_");
      a.download = `${safeTitle}.${currentFormat}`;
      a.click();
      URL.revokeObjectURL(url);
    };

    // LYRIMO で開く
    let openBtn = document.createElement("a");
    openBtn.textContent = "🚀 LYRIMO で開く";
    openBtn.target = "_blank";
    Object.assign(openBtn.style, {
      flex: "1.2",
      minWidth: "120px",
      padding: "10px",
      background: "#6366f1",
      color: "#fff",
      border: "none",
      borderRadius: "8px",
      fontWeight: "bold",
      cursor: "pointer",
      textAlign: "center",
      textDecoration: "none",
      display: "inline-block",
      boxSizing: "border-box"
    });
    openBtn.onclick = () => {
      let lyrimoUrl = `https://amfmu49-spec.github.io/lyrimo/#lrc=${encodeURIComponent(textarea.value)}&audio_url=${encodeURIComponent(audioUrl)}`;
      openBtn.href = lyrimoUrl;
    };

    // 閉じる
    let closeBtn = document.createElement("button");
    closeBtn.textContent = "✕ 閉じる";
    Object.assign(closeBtn.style, {
      padding: "10px 16px",
      background: "#27272a",
      color: "#a1a1aa",
      border: "none",
      borderRadius: "8px",
      cursor: "pointer"
    });
    closeBtn.onclick = () => overlay.remove();

    btnRow.appendChild(copyBtn);
    btnRow.appendChild(dlBtn);
    btnRow.appendChild(openBtn);
    btnRow.appendChild(closeBtn);
    box.appendChild(btnRow);

    overlay.appendChild(box);
    document.body.appendChild(overlay);
  })();
})();
