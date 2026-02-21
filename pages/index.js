import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import Head from "next/head";
import { normalizeSvg } from "../lib/svg-normalize";
import { buildRegistries } from "../lib/svg-registry";
import { classifyWhiteRegions } from "../lib/white-classifier";
import { clusterShapes } from "../lib/cluster";
import { generateReport, reportToPromptHints } from "../lib/analysis-report";
import { generateAllVersions } from "../lib/version-engine";

const FILLABLE = new Set(["path", "polygon", "rect", "circle", "ellipse", "polyline"]);

function hex2rgb(h) {
  h = h.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}
function rgb2hex({ r, g, b }) {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}
function lerp(a, b, t) {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

/* ────────────────────── Minimal ZIP builder (no deps) ────────────────────── */
function buildZip(files) {
  // files: [{ name: string, data: Uint8Array }]
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = new TextEncoder().encode(f.name);
    // Local file header
    const lh = new Uint8Array(30 + nameBytes.length + f.data.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); // sig
    lv.setUint16(4, 20, true); // version
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, 0, true); // compression (store)
    lv.setUint16(10, 0, true); // mod time
    lv.setUint16(12, 0, true); // mod date
    // crc32
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < f.data.length; i++) {
      crc ^= f.data[i];
      for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
    crc ^= 0xFFFFFFFF;
    lv.setUint32(14, crc, true);
    lv.setUint32(18, f.data.length, true); // compressed
    lv.setUint32(22, f.data.length, true); // uncompressed
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra length
    lh.set(nameBytes, 30);
    lh.set(f.data, 30 + nameBytes.length);
    localHeaders.push(lh);
    // Central directory header
    const ch = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.data.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    ch.set(nameBytes, 46);
    centralHeaders.push(ch);
    offset += lh.length;
  }
  const cdOffset = offset;
  let cdSize = 0;
  for (const ch of centralHeaders) cdSize += ch.length;
  // End of central directory
  const ecd = new Uint8Array(22);
  const ev = new DataView(ecd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdOffset, true);
  ev.setUint16(20, 0, true);
  const parts = [...localHeaders, ...centralHeaders, ecd];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const zip = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { zip.set(p, pos); pos += p.length; }
  return zip;
}

function downloadFile(name, data, mime) {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function svgToPngBase64(svgEl) {
  return new Promise((resolve, reject) => {
    const clone = svgEl.cloneNode(true);
    clone.querySelectorAll(".sel").forEach((e) => e.classList.remove("sel"));
    clone.removeAttribute("style");
    if (!clone.getAttribute("xmlns"))
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const vb = clone.getAttribute("viewBox");
    let w = 512,
      h = 512;
    if (vb) {
      const p = vb.split(/\s+/).map(Number);
      w = p[2] || 512;
      h = p[3] || 512;
    }
    const scale = Math.min(400 / w, 400 / h, 1);
    const cw = Math.round(w * scale),
      ch = Math.round(h * scale);
    const blob = new Blob(
      [new XMLSerializer().serializeToString(clone)],
      { type: "image/svg+xml;charset=utf-8" }
    );
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(img, 0, 0, cw, ch);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/png").split(",")[1]);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("render failed"));
    };
    img.src = url;
  });
}

/* ────────────────────── TETRIS (Premium) ────────────────────── */
const T_COLS = 10, T_ROWS = 20, T_SZ = 28;
const T_PIECES = [
  { shape: [[1,1,1,1]], color: "#00b4d8", glow: "#0094b8" },
  { shape: [[1,1],[1,1]], color: "#e9c46a", glow: "#c9a44a" },
  { shape: [[0,1,0],[1,1,1]], color: "#9b5de5", glow: "#7b3dc5" },
  { shape: [[1,0,0],[1,1,1]], color: "#e85d26", glow: "#c83d06" },
  { shape: [[0,0,1],[1,1,1]], color: "#3b82f6", glow: "#1b62d6" },
  { shape: [[0,1,1],[1,1,0]], color: "#06d6a0", glow: "#04b680" },
  { shape: [[1,1,0],[0,1,1]], color: "#ef476f", glow: "#cf274f" },
];

function Tetris() {
  const canvasRef = useRef(null);
  const st = useRef(null);
  const raf = useRef(null);
  const lastDrop = useRef(0);
  const keys = useRef({});
  const lastMove = useRef(0);
  const touchStart = useRef(null);
  const [score, setScore] = useState(0);
  const [level, setLevel] = useState(1);
  const [lines, setLines] = useState(0);
  const [gameOver, setGameOver] = useState(false);

  function newBag() {
    const bag = [...Array(T_PIECES.length).keys()];
    for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; }
    return bag;
  }

  const init = useCallback(() => {
    const grid = Array.from({ length: T_ROWS }, () => Array(T_COLS).fill(0));
    const colors = Array.from({ length: T_ROWS }, () => Array(T_COLS).fill(null));
    const bag = newBag();
    st.current = { grid, colors, piece: null, px: 0, py: 0, speed: 500, bag, next: null, linesTotal: 0, flashRows: [], flashTime: 0 };
    setScore(0); setLevel(1); setLines(0); setGameOver(false);
    lastDrop.current = 0;
    spawnPiece();
  }, []);

  function spawnPiece() {
    const s = st.current;
    if (s.bag.length < 2) s.bag.push(...newBag());
    const idx = s.bag.shift();
    const nextIdx = s.bag[0];
    s.next = T_PIECES[nextIdx];
    const t = T_PIECES[idx];
    s.piece = { shape: t.shape.map(r => [...r]), color: t.color, glow: t.glow };
    s.px = Math.floor((T_COLS - t.shape[0].length) / 2);
    s.py = 0;
    if (tCollides(s.grid, s.piece.shape, s.px, s.py)) setGameOver(true);
  }

  function tCollides(grid, shape, px, py) {
    for (let r = 0; r < shape.length; r++)
      for (let c = 0; c < shape[r].length; c++)
        if (shape[r][c]) {
          const nx = px + c, ny = py + r;
          if (nx < 0 || nx >= T_COLS || ny >= T_ROWS) return true;
          if (ny >= 0 && grid[ny][nx]) return true;
        }
    return false;
  }

  function tLock() {
    const s = st.current;
    const { shape, color } = s.piece;
    for (let r = 0; r < shape.length; r++)
      for (let c = 0; c < shape[r].length; c++)
        if (shape[r][c]) {
          const ny = s.py + r, nx = s.px + c;
          if (ny >= 0 && ny < T_ROWS && nx >= 0 && nx < T_COLS) {
            s.grid[ny][nx] = 1;
            s.colors[ny][nx] = color;
          }
        }
    let cleared = 0;
    const flashRows = [];
    for (let r = T_ROWS - 1; r >= 0; r--) {
      if (s.grid[r].every(v => v)) { flashRows.push(r); cleared++; }
    }
    if (cleared) {
      s.flashRows = flashRows;
      s.flashTime = performance.now();
      setTimeout(() => {
        for (const row of flashRows.sort((a, b) => b - a)) {
          s.grid.splice(row, 1); s.colors.splice(row, 1);
          s.grid.unshift(Array(T_COLS).fill(0)); s.colors.unshift(Array(T_COLS).fill(null));
        }
        s.flashRows = [];
      }, 200);
      const pts = [0, 100, 300, 500, 800][cleared] || 800;
      setScore(p => p + pts * Math.ceil(s.linesTotal / 10 + 1));
      s.linesTotal += cleared;
      setLines(s.linesTotal);
      const newLvl = Math.floor(s.linesTotal / 10) + 1;
      setLevel(newLvl);
      s.speed = Math.max(80, 500 - (newLvl - 1) * 40);
    }
    spawnPiece();
  }

  function tRotate(shape) {
    const rows = shape.length, cols = shape[0].length;
    const r = Array.from({ length: cols }, () => Array(rows).fill(0));
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) r[x][rows - 1 - y] = shape[y][x];
    return r;
  }

  function tHardDrop() {
    const s = st.current;
    while (!tCollides(s.grid, s.piece.shape, s.px, s.py + 1)) s.py++;
    tLock();
    lastDrop.current = performance.now();
  }

  function tDraw() {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext("2d");
    const s = st.current;
    const BW = T_COLS * T_SZ, NW = 5 * T_SZ;
    // Background
    ctx.fillStyle = "#111115";
    ctx.fillRect(0, 0, cvs.width, cvs.height);
    // Board area
    ctx.fillStyle = "#16161a";
    ctx.fillRect(0, 0, BW, T_ROWS * T_SZ);
    // Grid
    ctx.strokeStyle = "#222228";
    ctx.lineWidth = 0.5;
    for (let r = 0; r <= T_ROWS; r++) { ctx.beginPath(); ctx.moveTo(0, r * T_SZ); ctx.lineTo(BW, r * T_SZ); ctx.stroke(); }
    for (let c = 0; c <= T_COLS; c++) { ctx.beginPath(); ctx.moveTo(c * T_SZ, 0); ctx.lineTo(c * T_SZ, T_ROWS * T_SZ); ctx.stroke(); }
    // Locked blocks
    for (let r = 0; r < T_ROWS; r++)
      for (let c = 0; c < T_COLS; c++)
        if (s.grid[r][c]) {
          const flash = s.flashRows.includes(r);
          const clr = flash ? "#ffffff" : s.colors[r][c];
          const x = c * T_SZ, y = r * T_SZ;
          ctx.fillStyle = clr;
          ctx.fillRect(x + 1, y + 1, T_SZ - 2, T_SZ - 2);
          if (!flash) {
            // Highlight
            ctx.fillStyle = "rgba(255,255,255,0.18)";
            ctx.fillRect(x + 1, y + 1, T_SZ - 2, 3);
            ctx.fillRect(x + 1, y + 1, 3, T_SZ - 2);
            // Shadow
            ctx.fillStyle = "rgba(0,0,0,0.15)";
            ctx.fillRect(x + T_SZ - 3, y + 1, 2, T_SZ - 2);
            ctx.fillRect(x + 1, y + T_SZ - 3, T_SZ - 2, 2);
          }
        }
    // Active piece
    if (s.piece) {
      const { shape, color, glow } = s.piece;
      // Ghost
      let gy = s.py;
      while (!tCollides(s.grid, shape, s.px, gy + 1)) gy++;
      for (let r = 0; r < shape.length; r++)
        for (let c = 0; c < shape[r].length; c++)
          if (shape[r][c]) {
            const x = (s.px + c) * T_SZ, y = (gy + r) * T_SZ;
            ctx.strokeStyle = color + "60";
            ctx.lineWidth = 1.5;
            ctx.strokeRect(x + 2, y + 2, T_SZ - 4, T_SZ - 4);
          }
      // Piece
      for (let r = 0; r < shape.length; r++)
        for (let c = 0; c < shape[r].length; c++)
          if (shape[r][c]) {
            const x = (s.px + c) * T_SZ, y = (s.py + r) * T_SZ;
            ctx.fillStyle = color;
            ctx.fillRect(x + 1, y + 1, T_SZ - 2, T_SZ - 2);
            ctx.fillStyle = "rgba(255,255,255,0.25)";
            ctx.fillRect(x + 1, y + 1, T_SZ - 2, 3);
            ctx.fillRect(x + 1, y + 1, 3, T_SZ - 2);
            ctx.fillStyle = "rgba(0,0,0,0.12)";
            ctx.fillRect(x + T_SZ - 3, y + 1, 2, T_SZ - 2);
            ctx.fillRect(x + 1, y + T_SZ - 3, T_SZ - 2, 2);
          }
    }
    // Side panel
    const sx = BW + 12;
    ctx.fillStyle = "#888";
    ctx.font = "bold 11px 'JetBrains Mono', monospace";
    ctx.fillText("NEXT", sx, 18);
    // Next piece preview
    if (s.next) {
      const nShape = s.next.shape;
      const ns = 16;
      const offy = 28;
      const offx = sx + (NW - nShape[0].length * ns) / 2 - 6;
      for (let r = 0; r < nShape.length; r++)
        for (let c = 0; c < nShape[r].length; c++)
          if (nShape[r][c]) {
            ctx.fillStyle = s.next.color;
            ctx.fillRect(offx + c * ns + 1, offy + r * ns + 1, ns - 2, ns - 2);
            ctx.fillStyle = "rgba(255,255,255,0.2)";
            ctx.fillRect(offx + c * ns + 1, offy + r * ns + 1, ns - 2, 2);
          }
    }
    // Stats
    ctx.fillStyle = "#555";
    ctx.font = "10px 'JetBrains Mono', monospace";
    ctx.fillText("SCORE", sx, 110);
    ctx.fillStyle = "#e85d26";
    ctx.font = "bold 18px 'JetBrains Mono', monospace";
    ctx.fillText(String(score), sx, 132);
    ctx.fillStyle = "#555";
    ctx.font = "10px 'JetBrains Mono', monospace";
    ctx.fillText("LEVEL", sx, 160);
    ctx.fillStyle = "#9b5de5";
    ctx.font = "bold 16px 'JetBrains Mono', monospace";
    ctx.fillText(String(level), sx, 180);
    ctx.fillStyle = "#555";
    ctx.font = "10px 'JetBrains Mono', monospace";
    ctx.fillText("LINES", sx, 208);
    ctx.fillStyle = "#06d6a0";
    ctx.font = "bold 16px 'JetBrains Mono', monospace";
    ctx.fillText(String(lines), sx, 228);
  }

  useEffect(() => {
    init();
    const onKey = (e) => {
      if (["ArrowLeft","ArrowRight","ArrowDown","ArrowUp"," "].includes(e.key)) e.preventDefault();
      if (e.key === " " && st.current && !gameOver) { tHardDrop(); return; }
      keys.current[e.key] = true;
    };
    const onKeyUp = (e) => { keys.current[e.key] = false; };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    const cvs = canvasRef.current;
    if (cvs) {
      const onTS = (e) => { touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, time: Date.now() }; };
      const onTE = (e) => {
        if (!touchStart.current) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - touchStart.current.x, dy = t.clientY - touchStart.current.y;
        const dt = Date.now() - touchStart.current.time;
        const ax = Math.abs(dx), ay = Math.abs(dy);
        if (ax < 10 && ay < 10 && dt < 300) {
          keys.current["ArrowUp"] = true; setTimeout(() => { keys.current["ArrowUp"] = false; }, 80);
        } else if (ay > ax && dy < -30) {
          tHardDrop();
        } else if (ax > ay && ax > 20) {
          const k = dx > 0 ? "ArrowRight" : "ArrowLeft";
          keys.current[k] = true; setTimeout(() => { keys.current[k] = false; }, 80);
        } else if (ay > ax && dy > 20) {
          keys.current["ArrowDown"] = true; setTimeout(() => { keys.current["ArrowDown"] = false; }, 80);
        }
        touchStart.current = null;
      };
      cvs.addEventListener("touchstart", onTS, { passive: true });
      cvs.addEventListener("touchend", onTE, { passive: true });
      return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("keyup", onKeyUp); cvs.removeEventListener("touchstart", onTS); cvs.removeEventListener("touchend", onTE); if (raf.current) cancelAnimationFrame(raf.current); };
    }
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("keyup", onKeyUp); if (raf.current) cancelAnimationFrame(raf.current); };
  }, [init]);

  useEffect(() => {
    if (gameOver) return;
    const loop = (ts) => {
      const s = st.current;
      if (!s || !s.piece) { raf.current = requestAnimationFrame(loop); return; }
      const now = ts || 0;
      if (now - lastMove.current > 70) {
        if (keys.current["ArrowLeft"] && !tCollides(s.grid, s.piece.shape, s.px - 1, s.py)) s.px--;
        if (keys.current["ArrowRight"] && !tCollides(s.grid, s.piece.shape, s.px + 1, s.py)) s.px++;
        if (keys.current["ArrowDown"] && !tCollides(s.grid, s.piece.shape, s.px, s.py + 1)) { s.py++; lastDrop.current = now; }
        if (keys.current["ArrowUp"]) {
          const rot = tRotate(s.piece.shape);
          const kicks = [0, -1, 1, -2, 2];
          for (const k of kicks) { if (!tCollides(s.grid, rot, s.px + k, s.py)) { s.piece.shape = rot; s.px += k; break; } }
          keys.current["ArrowUp"] = false;
        }
        lastMove.current = now;
      }
      if (now - lastDrop.current > s.speed) {
        if (!tCollides(s.grid, s.piece.shape, s.px, s.py + 1)) s.py++;
        else tLock();
        lastDrop.current = now;
      }
      tDraw();
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, [gameOver, score, level, lines]);

  const CW = T_COLS * T_SZ + 5 * T_SZ + 12;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
      <canvas ref={canvasRef} width={CW} height={T_ROWS * T_SZ} style={{ borderRadius: 12, border: "1px solid #2a2a2e" }} />
      {gameOver && (
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 14, color: "#e85d26", fontWeight: 700 }}>Game Over — {score} pts</span>
          <button onClick={init} style={{ padding: "5px 14px", borderRadius: 8, border: "1px solid #e5e4e0", background: "#fff", color: "#e85d26", fontSize: 12, cursor: "pointer", fontFamily: "'DM Sans', sans-serif", fontWeight: 600 }}>Play Again</button>
        </div>
      )}
      <div style={{ fontSize: 10, color: "#888", textAlign: "center", lineHeight: 1.5 }}>
        {"\u2190\u2192"} move {"  \u2191"} rotate {"  \u2193"} soft drop {"  "} space = hard drop
      </div>
    </div>
  );
}

/* ────────────────────── SNAKE (mobile) ────────────────────── */
const SN_COLS = 20, SN_ROWS = 20, SN_SZ = 14;

function SnakeGame() {
  const canvasRef = useRef(null);
  const stRef = useRef(null);
  const raf = useRef(null);
  const touchStart = useRef(null);
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(0);
  const [gameOver, setGameOver] = useState(false);

  function placeFood(snake) {
    const occupied = new Set(snake.map(s => s.y * SN_COLS + s.x));
    let fx, fy;
    do { fx = Math.floor(Math.random() * SN_COLS); fy = Math.floor(Math.random() * SN_ROWS); } while (occupied.has(fy * SN_COLS + fx));
    return { x: fx, y: fy };
  }

  const initGame = useCallback(() => {
    const snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }];
    stRef.current = { snake, dir: { dx: 1, dy: 0 }, next: null, food: placeFood(snake), grow: 0 };
    setScore(0); setGameOver(false);
  }, []);

  useEffect(() => {
    initGame();
    const cvs = canvasRef.current;
    if (!cvs) return;
    const onTS = (e) => { touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; };
    const onTE = (e) => {
      if (!touchStart.current || !stRef.current) return;
      const dx = e.changedTouches[0].clientX - touchStart.current.x;
      const dy = e.changedTouches[0].clientY - touchStart.current.y;
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      const s = stRef.current;
      if (Math.abs(dx) > Math.abs(dy)) {
        if (dx > 0 && s.dir.dx !== -1) s.next = { dx: 1, dy: 0 };
        else if (dx < 0 && s.dir.dx !== 1) s.next = { dx: -1, dy: 0 };
      } else {
        if (dy > 0 && s.dir.dy !== -1) s.next = { dx: 0, dy: 1 };
        else if (dy < 0 && s.dir.dy !== 1) s.next = { dx: 0, dy: -1 };
      }
      touchStart.current = null;
    };
    const onKey = (e) => {
      if (!stRef.current) return;
      const s = stRef.current;
      const map = {
        ArrowLeft: s.dir.dx !== 1 ? { dx: -1, dy: 0 } : null,
        ArrowRight: s.dir.dx !== -1 ? { dx: 1, dy: 0 } : null,
        ArrowUp: s.dir.dy !== 1 ? { dx: 0, dy: -1 } : null,
        ArrowDown: s.dir.dy !== -1 ? { dx: 0, dy: 1 } : null,
      };
      if (map[e.key]) { e.preventDefault(); s.next = map[e.key]; }
    };
    cvs.addEventListener("touchstart", onTS, { passive: true });
    cvs.addEventListener("touchend", onTE, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => { cvs.removeEventListener("touchstart", onTS); cvs.removeEventListener("touchend", onTE); window.removeEventListener("keydown", onKey); if (raf.current) cancelAnimationFrame(raf.current); };
  }, [initGame]);

  useEffect(() => {
    if (gameOver) return;
    let last = 0;
    const speed = 100;
    const loop = (ts) => {
      const s = stRef.current;
      if (!s) { raf.current = requestAnimationFrame(loop); return; }
      if (ts - last > speed) {
        last = ts;
        if (s.next) { s.dir = s.next; s.next = null; }
        const head = s.snake[0];
        const nx = head.x + s.dir.dx, ny = head.y + s.dir.dy;
        // Wall collision
        if (nx < 0 || nx >= SN_COLS || ny < 0 || ny >= SN_ROWS) { setGameOver(true); return; }
        // Self collision
        if (s.snake.some(seg => seg.x === nx && seg.y === ny)) { setGameOver(true); return; }
        s.snake.unshift({ x: nx, y: ny });
        // Food
        if (nx === s.food.x && ny === s.food.y) {
          s.grow += 2;
          s.food = placeFood(s.snake);
          setScore(p => { const ns = p + 10; setBest(b => Math.max(b, ns)); return ns; });
        }
        if (s.grow > 0) s.grow--;
        else s.snake.pop();
      }
      // Draw
      const cvs = canvasRef.current;
      if (!cvs) { raf.current = requestAnimationFrame(loop); return; }
      const ctx = cvs.getContext("2d");
      const W = SN_COLS * SN_SZ, H = SN_ROWS * SN_SZ;
      // Background grid
      for (let r = 0; r < SN_ROWS; r++)
        for (let c = 0; c < SN_COLS; c++) {
          ctx.fillStyle = (r + c) % 2 === 0 ? "#1a1e24" : "#1e222a";
          ctx.fillRect(c * SN_SZ, r * SN_SZ, SN_SZ, SN_SZ);
        }
      // Food with glow
      const fx = s.food.x * SN_SZ + SN_SZ / 2, fy = s.food.y * SN_SZ + SN_SZ / 2;
      const pulse = 0.8 + 0.2 * Math.sin(ts / 200);
      const grd = ctx.createRadialGradient(fx, fy, 0, fx, fy, SN_SZ * pulse);
      grd.addColorStop(0, "rgba(239,71,111,0.3)");
      grd.addColorStop(1, "rgba(239,71,111,0)");
      ctx.fillStyle = grd;
      ctx.fillRect(s.food.x * SN_SZ - SN_SZ, s.food.y * SN_SZ - SN_SZ, SN_SZ * 3, SN_SZ * 3);
      ctx.fillStyle = "#ef476f";
      ctx.beginPath();
      ctx.arc(fx, fy, SN_SZ / 2 - 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.3)";
      ctx.beginPath();
      ctx.arc(fx - 1, fy - 1, 2, 0, Math.PI * 2);
      ctx.fill();
      // Snake
      const len = s.snake.length;
      for (let i = 0; i < len; i++) {
        const seg = s.snake[i];
        const t = 1 - i / len;
        const r = Math.round(6 + 226 * t), g = Math.round(214 - 80 * t), b = Math.round(160 - 120 * t);
        const rad = (SN_SZ / 2 - 1) * (0.7 + 0.3 * t);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.beginPath();
        ctx.arc(seg.x * SN_SZ + SN_SZ / 2, seg.y * SN_SZ + SN_SZ / 2, rad, 0, Math.PI * 2);
        ctx.fill();
        if (i === 0) {
          // Eyes
          const ex = seg.x * SN_SZ + SN_SZ / 2 + s.dir.dx * 3;
          const ey = seg.y * SN_SZ + SN_SZ / 2 + s.dir.dy * 3;
          ctx.fillStyle = "#fff";
          ctx.beginPath(); ctx.arc(ex - s.dir.dy * 2, ey + s.dir.dx * 2, 2.5, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath(); ctx.arc(ex + s.dir.dy * 2, ey - s.dir.dx * 2, 2.5, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = "#111";
          ctx.beginPath(); ctx.arc(ex - s.dir.dy * 2 + s.dir.dx * 0.5, ey + s.dir.dx * 2 + s.dir.dy * 0.5, 1.2, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath(); ctx.arc(ex + s.dir.dy * 2 + s.dir.dx * 0.5, ey - s.dir.dx * 2 + s.dir.dy * 0.5, 1.2, 0, Math.PI * 2); ctx.fill();
        }
      }
      // Score overlay
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.font = "bold 10px 'JetBrains Mono', monospace";
      ctx.fillText(`${score}`, 4, 12);
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, [gameOver, score]);

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
      <canvas ref={canvasRef} width={SN_COLS * SN_SZ} height={SN_ROWS * SN_SZ} style={{ borderRadius: 12, border: "1px solid #2a2a2e", touchAction: "none" }} />
      {gameOver && (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 13, color: "#e85d26", fontWeight: 700 }}>{score} pts {best > 0 && score >= best ? "(new best!)" : ""}</span>
          <button onClick={initGame} style={{ padding: "5px 14px", borderRadius: 8, border: "1px solid #e5e4e0", background: "#fff", color: "#e85d26", fontSize: 12, cursor: "pointer", fontFamily: "'DM Sans', sans-serif", fontWeight: 600 }}>Play Again</button>
        </div>
      )}
      <div style={{ fontSize: 10, color: "#888", textAlign: "center" }}>Swipe or arrow keys to steer</div>
    </div>
  );
}

/* ────────────────────── GAME PICKER ────────────────────── */
function WaitGame() {
  const [game, setGame] = useState("tetris");
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => { setIsMobile(window.innerWidth <= 640 || "ontouchstart" in window); }, []);
  useEffect(() => { if (isMobile) setGame("snake"); }, [isMobile]);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
      <div style={{ display: "flex", gap: 4 }}>
        {["tetris", "snake"].map((g) => (
          <button
            key={g}
            onClick={() => setGame(g)}
            style={{
              padding: "4px 12px", borderRadius: 6, fontSize: 11, fontWeight: game === g ? 600 : 400,
              border: "1px solid " + (game === g ? "#e85d26" : "#ddd"),
              background: game === g ? "#fff7f5" : "#fff",
              color: game === g ? "#e85d26" : "#999",
              cursor: "pointer", fontFamily: "'DM Sans', sans-serif",
            }}
          >
            {g === "tetris" ? "Tetris" : "Snake"}
          </button>
        ))}
      </div>
      {game === "tetris" ? <Tetris /> : <SnakeGame />}
    </div>
  );
}

/* ────────────────────── STATES ────────────────────── */
// "idle" → "uploading" → "vectorizing" → "analyzing" → "ready"

export default function Home() {
  const [step, setStep] = useState("idle");
  const [error, setError] = useState("");
  const [svgSource, setSvgSource] = useState("");
  const [history, setHistory] = useState([]);
  const [hIdx, setHIdx] = useState(-1);
  const [shapes, setShapes] = useState([]);
  const [sel, setSel] = useState(new Set());
  const [analysis, setAnalysis] = useState(null);
  const [validation, setValidation] = useState(null);
  const [analysisReport, setAnalysisReport] = useState(null);
  const [versions, setVersions] = useState(null);
  const [activeVersionTab, setActiveVersionTab] = useState(null);
  const [versionApprovals, setVersionApprovals] = useState({}); // { [versionId]: "approved" | "rejected" }
  const registriesRef = useRef(null);
  const [showDebugPanel, setShowDebugPanel] = useState(false);
  const [moduleMode, setModuleMode] = useState("default"); // "default" | "color" | "accuracy" | "versions"
  const [dragOver, setDragOver] = useState(false);
  const [preview, setPreview] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [logs, setLogs] = useState([]);
  const timerRef = useRef(null);
  const logStartRef = useRef(0);

  const addLog = useCallback((msg) => {
    const t = ((Date.now() - logStartRef.current) / 1000).toFixed(1);
    setLogs((p) => [...p, { t, msg }]);
  }, []);

  // Edit state
  const [mode, setMode] = useState("solid");
  const [solidClr, setSolidClr] = useState("#ffffff");
  const [gStart, setGStart] = useState("#3b82f6");
  const [gEnd, setGEnd] = useState("#8b5cf6");
  const [gType, setGType] = useState("linear");
  const [gAngle, setGAngle] = useState(135);
  const [copied, setCopied] = useState(false);

  const [gradEditTarget, setGradEditTarget] = useState(null); // shape id being gradient-edited
  const [gradEditType, setGradEditType] = useState("linear");
  const [gradEditC1, setGradEditC1] = useState("#3b82f6");
  const [gradEditC2, setGradEditC2] = useState("#8b5cf6");
  const [gradEditAngle, setGradEditAngle] = useState(135);
  const [fixing, setFixing] = useState(false);
  const [fixNote, setFixNote] = useState("");
  const [showGptDebug, setShowGptDebug] = useState(false);
  const [fileMeta, setFileMeta] = useState(null);
  const [debugTick, setDebugTick] = useState(0); // forces re-render of debug panel

  // Debug bundle — mutable ref captures everything during pipeline without batching issues
  const debugRef = useRef({ events: [], uploadedFile: null, uploadedFileName: null, uploadedFileSize: null, uploadedMime: null, vectorizerSvg: null, finalSvg: null, originalB64: null, originalMime: null });

  const captureDebug = useCallback((type, label, data) => {
    debugRef.current.events.push({ type, label, data, ts: Date.now(), time: new Date().toLocaleTimeString() });
  }, []);

  const resetDebug = useCallback(() => {
    debugRef.current = { events: [], uploadedFile: null, uploadedFileName: null, uploadedFileSize: null, uploadedMime: null, vectorizerSvg: null, finalSvg: null, originalB64: null, originalMime: null };
    setDebugTick(0);
  }, []);

  // Back-compat alias so existing addGptResponse calls still work
  const addGptResponse = useCallback((stepLabel, data, question) => {
    captureDebug("gpt_response", stepLabel, { response: data, question: question || "" });
    setDebugTick((t) => t + 1);
  }, [captureDebug]);

  const svgRef = useRef(null);
  const displayRef = useRef(null);
  const fileRef = useRef(null);
  const originalB64Ref = useRef(null);
  const originalMimeRef = useRef(null);
  const structuralHintsRef = useRef("");

  /* ─── History ─── */
  const push = useCallback(
    (s) => {
      setHistory((p) => [...p.slice(0, hIdx + 1), s]);
      setHIdx((p) => p + 1);
    },
    [hIdx]
  );

  /* ─── Load SVG into DOM ─── */
  const mountSvg = useCallback(
    (text) => {
      const c = text.trim();
      if (!c.startsWith("<svg") && !c.startsWith("<?xml")) return;
      setSvgSource(c);
      push(c);
    },
    [push]
  );

  /* ─── Walk SVG and discover fillable shapes ─── */
  const discoverShapes = useCallback((svg) => {
    const found = [];
    let si = 0;
    const walk = (el) => {
      if (FILLABLE.has(el.tagName?.toLowerCase())) {
        const f = el.getAttribute("fill");
        if (f === "none") return;
        const computed = f || window.getComputedStyle(el).fill || "#000";
        const parsedFill = computed.startsWith("rgb")
          ? "#" + [...computed.matchAll(/\d+/g)].map((m) => (+m[0]).toString(16).padStart(2, "0")).join("")
          : computed;
        if (!el.id) el.id = "s" + si;
        found.push({ id: el.id, tag: el.tagName, fill: parsedFill || "#000" });
        si++;
      }
      if (el.children) [...el.children].forEach(walk);
    };
    walk(svg);
    return found;
  }, []);

  /* ─── Helper: call GPT analyze endpoint ─── */
  const callGPT = useCallback(async (body) => {
    const ac = new AbortController();
    const at = setTimeout(() => ac.abort(), 65000);
    const resp = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    clearTimeout(at);
    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      const detail = typeof errBody.error === "string" ? errBody.error.slice(0, 200) : JSON.stringify(errBody).slice(0, 200);
      addLog(`GPT error detail: ${detail}`);
      captureDebug("error", "GPT API Error", { status: resp.status, detail });
      throw new Error("GPT request failed (" + resp.status + ")");
    }
    return resp.json();
  }, [addLog, captureDebug]);

  /* ─── Helper: create SVG gradient element ─── */
  const createSvgGradient = useCallback((svg, grad, gid) => {
    let defs = svg.querySelector("defs");
    if (!defs) {
      defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
      svg.prepend(defs);
    }
    const ns = "http://www.w3.org/2000/svg";
    let g;
    if (grad.type === "radial") {
      g = document.createElementNS(ns, "radialGradient");
      g.setAttribute("cx", "50%");
      g.setAttribute("cy", "50%");
      g.setAttribute("r", "50%");
    } else {
      g = document.createElementNS(ns, "linearGradient");
      const r = ((grad.angle || 135) * Math.PI) / 180;
      g.setAttribute("x1", 50 - Math.cos(r) * 50 + "%");
      g.setAttribute("y1", 50 - Math.sin(r) * 50 + "%");
      g.setAttribute("x2", 50 + Math.cos(r) * 50 + "%");
      g.setAttribute("y2", 50 + Math.sin(r) * 50 + "%");
    }
    g.setAttribute("id", gid);
    g.setAttribute("gradientUnits", "objectBoundingBox");
    (grad.stops || []).forEach((stop) => {
      const st = document.createElementNS(ns, "stop");
      st.setAttribute("offset", stop.offset || "0%");
      st.setAttribute("stop-color", stop.color || "#000");
      g.appendChild(st);
    });
    defs.appendChild(g);
    return "url(#" + gid + ")";
  }, []);

  /* ─── Full pipeline ─── */
  const processFile = useCallback(
    async (file) => {
      setError("");
      setAnalysis(null);
      setValidation(null);
      setAnalysisReport(null);
      setVersions(null);
      setActiveVersionTab(null);
      setVersionApprovals({});
      registriesRef.current = null;
      setShowDebugPanel(false);
      setGradEditTarget(null);
      setFixing(false);
      setFixNote("");
      resetDebug();
      setShowGptDebug(false);
      setModuleMode("default");
      setFileMeta(null);
      setSvgSource("");
      setShapes([]);
      setSel(new Set());
      setLogs([]);
      logStartRef.current = Date.now();

      const isSvg = file.type === "image/svg+xml" || file.name.endsWith(".svg");
      const sizeMB = (file.size / 1024 / 1024).toFixed(2);

      setPreview(URL.createObjectURL(file));
      setStep("uploading");
      setElapsed(0);
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = setInterval(() => setElapsed((p) => p + 1), 1000);

      addLog(`File selected: ${file.name} (${sizeMB} MB, ${file.type || "unknown type"})`);

      // Capture uploaded file for debug
      debugRef.current.uploadedFileName = file.name;
      debugRef.current.uploadedFileSize = file.size;
      debugRef.current.uploadedMime = file.type || "unknown";
      try {
        const uploadedB64 = await fileToBase64(file);
        debugRef.current.uploadedFile = `data:${file.type || "application/octet-stream"};base64,${uploadedB64}`;
      } catch (_) {}
      captureDebug("info", "File Upload", { name: file.name, size: sizeMB + " MB", type: file.type || "unknown", isSvg });

      let svgText;
      let analysisData = null;
      let originalB64; // keep original image for validation later
      let originalMime;

      // ════════════════════════════════════════════════
      // STEP 1: Analyze original image with GPT
      // ════════════════════════════════════════════════
      setStep("analyzing");
      try {
        let shapeInfo = "";

        if (isSvg) {
          svgText = await file.text();
          debugRef.current.uploadedFile = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svgText)))}`;
          captureDebug("info", "SVG Source Loaded", { sizeKB: (svgText.length / 1024).toFixed(1) });
          addLog(`SVG loaded (${(svgText.length / 1024).toFixed(1)} KB)`);
          mountSvg(svgText);
          await new Promise((r) => setTimeout(r, 200));

          const svg = svgRef.current?.querySelector("svg");
          if (!svg) throw new Error("Failed to mount SVG");

          addLog("Rendering SVG to PNG for analysis…");
          originalB64 = await svgToPngBase64(svg);
          originalMime = "image/png";

          const preShapes = discoverShapes(svg);
          shapeInfo = preShapes
            .map((s, i) => `Shape ${i + 1}: id="${s.id}", tag=<${s.tag}>, fill="${s.fill}"`)
            .join("\n");
        } else {
          addLog("Converting image for analysis…");
          originalB64 = await fileToBase64(file);
          originalMime = file.type || "image/png";
        }

        originalB64Ref.current = originalB64;
        originalMimeRef.current = originalMime;
        debugRef.current.originalB64 = originalB64;
        debugRef.current.originalMime = originalMime;
        addLog(`Image encoded (${(originalB64.length * 0.75 / 1024).toFixed(1)} KB, ${originalMime})`);
        addLog("Sending to GPT-5.2 Vision for analysis…");
        captureDebug("gpt_request", "Step 1: Analysis — Request", { prompt: "Default analysis prompt", imageSizeKB: (originalB64.length * 0.75 / 1024).toFixed(1), mimeType: originalMime });

        analysisData = await callGPT({
          imageBase64: originalB64,
          mimeType: originalMime,
          shapeData: shapeInfo,
        });
        setAnalysis(analysisData);
        addGptResponse("Step 1: Analysis", analysisData, "Analyze this logo image: describe it, identify colors, gradients, complexity, layout, category, and mood.");
        addLog(`Analysis complete — ${analysisData.colors?.length || 0} colors, mood: ${analysisData.mood || "n/a"}`);

        if (analysisData.gradientSuggestion?.recommended) {
          const gs = analysisData.gradientSuggestion;
          setGStart(gs.startColor || "#3b82f6");
          setGEnd(gs.endColor || "#8b5cf6");
          setGType(gs.type || "linear");
          setGAngle(gs.angle || 135);
          setMode("gradient");
          addLog("Gradient suggestion loaded");
        }
      } catch (e) {
        const msg = e.name === "AbortError" ? "Analysis timed out (65s)." : e.message;
        captureDebug("error", "Analysis Failed", { error: msg, stack: e.stack?.slice(0, 500) });
        addLog(`WARNING: ${msg} — continuing without analysis`);
        setError(msg);
      }

      // ════════════════════════════════════════════════
      // STEP 2: Vectorize (raster only)
      // ════════════════════════════════════════════════
      if (!isSvg) {
        setStep("vectorizing");
        addLog("Sending to Vectorizer.ai API…");
        try {
          const form = new FormData();
          form.append("image", file);
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 65000);
          const resp = await fetch("/api/vectorize", {
            method: "POST",
            body: form,
            signal: controller.signal,
          });
          clearTimeout(timeout);
          addLog(`Vectorizer responded: HTTP ${resp.status}`);
          if (!resp.ok) {
            const errBody = await resp.text().catch(() => "");
            throw new Error("Vectorization failed (" + resp.status + "): " + errBody);
          }
          svgText = await resp.text();
          debugRef.current.vectorizerSvg = svgText;
          captureDebug("vectorizer", "Vectorizer.ai Response", { status: resp.status, sizeKB: (svgText.length / 1024).toFixed(1), svgPreview: svgText.slice(0, 500) + "…" });
          addLog(`Vectorization complete (${(svgText.length / 1024).toFixed(1)} KB SVG)`);
        } catch (e) {
          if (timerRef.current) clearInterval(timerRef.current);
          const msg = e.name === "AbortError" ? "Vectorization timed out (65s). Try a smaller image." : e.message;
          addLog(`ERROR: ${msg}`);
          setError(msg);
          setStep("idle");
          return;
        }

        addLog("Mounting vectorized SVG…");
        mountSvg(svgText);
        await new Promise((r) => setTimeout(r, 200));
      }

      // ════════════════════════════════════════════════
      // STEP 3: Label all paths in the single-color SVG
      // ════════════════════════════════════════════════
      const svg = svgRef.current?.querySelector("svg");
      const found = svg ? discoverShapes(svg) : [];
      setShapes(found);
      setSel(new Set());
      addLog(`Labeled ${found.length} paths: ${found.map((s) => s.id).join(", ")}`);

      // Build file metadata for info row
      {
        const vb = svg?.getAttribute("viewBox");
        let dims = "";
        if (vb) { const p = vb.split(/\s+/).map(Number); dims = `${p[2] || "?"}×${p[3] || "?"}`; }
        const uniqueColors = new Set(found.map((s) => s.fill.toLowerCase()));
        setFileMeta({
          name: file.name,
          size: file.size < 1024 ? file.size + " B" : file.size < 1048576 ? (file.size / 1024).toFixed(0) + " KB" : (file.size / 1048576).toFixed(1) + " MB",
          dimensions: dims,
          shapeCount: found.length,
          colorCount: uniqueColors.size,
          gradientCount: analysisData?.gradients?.length || 0,
        });
      }

      // ════════════════════════════════════════════════
      // STEP 3.5: Deterministic structural analysis
      // ════════════════════════════════════════════════
      let structuralHints = "";
      let localReport = null;
      try {
        if (svg) {
          addLog("Running deterministic structural analysis…");
          const normalizedSvg = normalizeSvg(svg);
          addLog("SVG normalized (use refs expanded, primitives→paths, transforms flattened)");

          const registries = buildRegistries(normalizedSvg);
          registriesRef.current = registries;
          addLog(`Registry built: ${registries.paths.size} paths, ${registries.paints.size} paints, ${registries.paintGroups.length} paint groups`);

          const whiteResults = classifyWhiteRegions(registries.paths, registries.paints, registries.bindings, normalizedSvg);
          addLog(`White regions classified: ${whiteResults.regions.length} found (bg: ${whiteResults.regions.filter(r => r.classification === "background_delete").length}, counters: ${whiteResults.regions.filter(r => r.classification === "counter_hole").length}, keep: ${whiteResults.regions.filter(r => r.classification === "interior_keep").length})`);

          const clusters = clusterShapes(registries.paths, registries.paints, registries.viewBox, analysisData);
          addLog(`Shape clusters: ${clusters.length} (${clusters.filter(c => c.type === "icon").length} icon, ${clusters.filter(c => c.type === "wordmark").length} wordmark)`);

          const report = generateReport(registries, whiteResults, clusters);
          localReport = report;
          setAnalysisReport(report);
          structuralHints = reportToPromptHints(report);
          structuralHintsRef.current = structuralHints;
          captureDebug("analysis", "Structural Analysis Report", { summary: report.summary, hints: structuralHints });
          addLog(`Analysis report generated — ${report.summary.pathCount} paths analyzed`);
        }
      } catch (e) {
        addLog(`WARNING: Structural analysis failed — ${e.message}. Continuing without hints.`);
        // Graceful fallback: pipeline continues without structural hints
      }

      // ════════════════════════════════════════════════
      // STEP 4: Send labeled paths + original to GPT for colorization
      // ════════════════════════════════════════════════
      if (svg && found.length > 0 && originalB64) {
        addLog("Sending labeled paths + original image to GPT for colorization…");
        try {
          const shapeList = found
            .map((s) => `${s.id}: <${s.tag}> (currently fill="${s.fill}")`)
            .join("\n");

          const colorizePrompt = `You are given the original logo image and a list of labeled SVG paths from vectorization. The vectorizer returned single-color outlines. Each path has a unique ID label.

Your task: look at the original logo image and assign the correct fill color or gradient to each labeled path so the SVG recreates the original logo's appearance as closely as possible.

Consider each path's spatial position in the image — which region of the original logo does it correspond to? Match colors accordingly: text shapes get text colors, icon shapes get icon colors, background shapes get background colors, etc. If the original has gradients, assign gradient fills to the appropriate paths.

Labeled paths:
${shapeList}
${structuralHints ? "\n" + structuralHints + "\n" : ""}
Return EXACT JSON (no code fences) with key "assignments": an array where each entry has:
- "shapeId": the path ID label (e.g. "s0", "s1")
- "fill": hex color string (e.g. "#253854") for solid fills
- "gradient": null for solid fills, OR { "type": "linear"|"radial", "angle": 0-360, "stops": [{"offset":"0%","color":"#hex"},{"offset":"100%","color":"#hex"}] } for gradient fills

Every labeled path MUST have an assignment. Return EXACT JSON only.`;

          captureDebug("gpt_request", "Step 4: Colorize — Request", { promptLength: colorizePrompt.length, promptPreview: colorizePrompt.slice(0, 300) + "…", shapeCount: found.length });
          const colorData = await callGPT({
            imageBase64: originalB64,
            mimeType: originalMime,
            customPrompt: colorizePrompt,
          });
          addGptResponse("Step 4: Colorize", colorData, `Assign correct fill colors/gradients to ${found.length} labeled SVG paths to match the original logo.`);

          const assignments = colorData.assignments || [];
          addLog(`Received ${assignments.length} color assignments`);

          let gradCount = 0;
          assignments.forEach((a, ai) => {
            const el = svg.getElementById(a.shapeId);
            if (!el) return;

            if (a.gradient && a.gradient.stops?.length >= 2) {
              const ref = createSvgGradient(svg, a.gradient, "cg" + ai);
              el.setAttribute("fill", ref);
              gradCount++;
            } else if (a.fill) {
              el.setAttribute("fill", a.fill);
            }
          });

          addLog(`Applied ${assignments.length} fills (${gradCount} gradient${gradCount !== 1 ? "s" : ""})`);

          // Update source with colorized SVG
          const colorizedSvg = svg.outerHTML;
          debugRef.current.finalSvg = colorizedSvg;
          captureDebug("info", "Colorized SVG Created", { sizeKB: (colorizedSvg.length / 1024).toFixed(1), shapeCount: found.length });
          setSvgSource(colorizedSvg);
          push(colorizedSvg);

          // Re-discover shapes with new fills
          const updatedShapes = discoverShapes(svg);
          setShapes(updatedShapes);

        } catch (e) {
          const msg = e.name === "AbortError" ? "Colorize timed out." : e.message;
          addLog(`WARNING: Colorize failed — ${msg}`);
          // Keep the single-color SVG as-is
          const fallbackSvg = svg.outerHTML;
          setSvgSource(fallbackSvg);
          push(fallbackSvg);
        }
      }

      // ════════════════════════════════════════════════
      // STEP 4.5: Generate color versions
      // ════════════════════════════════════════════════
      try {
        if (registriesRef.current && localReport && svg) {
          addLog("Generating color versions (Full, 3-5, 2, 1)…");
          const colorizedSvgStr = svg.outerHTML;
          const versionResults = generateAllVersions(registriesRef.current, localReport, colorizedSvgStr);
          setVersions(versionResults);
          if (versionResults.length > 0) {
            setActiveVersionTab(versionResults[0].id);
            setModuleMode("versions");
          }
          captureDebug("info", "Versions Generated", {
            count: versionResults.length,
            ids: versionResults.map(v => v.id),
            palettes: versionResults.map(v => ({ id: v.id, colors: v.palette })),
          });
          addLog(`Generated ${versionResults.length} versions: ${versionResults.map(v => v.label).join(", ")}`);
        }
      } catch (e) {
        addLog(`WARNING: Version generation failed — ${e.message}. Continuing without versions.`);
      }

      // ════════════════════════════════════════════════
      // STEP 5: Validate — send original + recolored SVG to GPT
      // ════════════════════════════════════════════════
      if (svg && originalB64) {
        try {
          addLog("Rendering recolored SVG for validation…");
          const recoloredB64 = await svgToPngBase64(svg);
          addLog("Sending original + recreation to GPT for validation…");
          captureDebug("gpt_request", "Step 5: Validate — Request", { note: "Comparing original vs colorized SVG render" });

          const validatePrompt = `Compare these two images. Image 1 is the original logo. Image 2 is our SVG vector recreation with colors assigned by AI.

Rate the accuracy of the recreation and provide feedback.

Return EXACT JSON (no code fences) with:
- "score": number 1-10 (10 = perfect match)
- "assessment": 1-2 sentences describing the overall accuracy
- "colorAccuracy": "excellent" | "good" | "fair" | "poor"
- "differences": array of brief strings noting any color/gradient differences (empty if perfect)
- "suggestions": array of brief improvement suggestions (empty if none)

Return EXACT JSON only.`;

          const valData = await callGPT({
            imageBase64: originalB64,
            mimeType: originalMime,
            imageBase64_2: recoloredB64,
            mimeType2: "image/png",
            customPrompt: validatePrompt,
          });

          setValidation(valData);
          addGptResponse("Step 5: Validate", valData, "Compare original logo vs SVG recreation and score accuracy 1-10.");
          addLog(`Validation: ${valData.score}/10 — ${valData.colorAccuracy || "n/a"} color accuracy`);
        } catch (e) {
          addLog(`WARNING: Validation failed — ${e.message}`);
        }
      }

      if (timerRef.current) clearInterval(timerRef.current);
      captureDebug("info", "Pipeline Complete", { elapsed: ((Date.now() - logStartRef.current) / 1000).toFixed(1) + "s" });
      // Snapshot final SVG for debug
      if (svg) debugRef.current.finalSvg = svg.outerHTML;
      setDebugTick((t) => t + 1);
      addLog("Done!");
      setStep("ready");
    },
    [mountSvg, addLog, addGptResponse, captureDebug, discoverShapes, push, callGPT, createSvgGradient]
  );

  /* ─── Re-render SVG on source change (edits, undo/redo) ─── */
  useEffect(() => {
    if (!svgSource) return;
    // Render into hidden workspace (always in DOM)
    if (svgRef.current) {
      svgRef.current.innerHTML = svgSource;
      const svg = svgRef.current.querySelector("svg");
      if (svg) {
        svg.style.width = "100%";
        svg.style.height = "100%";
        if (!svg.querySelector("defs")) {
          svg.prepend(document.createElementNS("http://www.w3.org/2000/svg", "defs"));
        }
      }
    }
    // Render into visible display (when ready)
    if (displayRef.current) {
      displayRef.current.innerHTML = svgSource;
      const svg = displayRef.current.querySelector("svg");
      if (svg) {
        svg.style.width = "100%";
        svg.style.height = "auto";
        svg.style.maxHeight = "320px";
        svg.style.maxWidth = "100%";
        if (!svg.querySelector("defs")) {
          svg.prepend(document.createElementNS("http://www.w3.org/2000/svg", "defs"));
        }
      }
    }
  }, [svgSource, step]);

  /* ─── Click-to-select shapes ─── */
  const handleShapeClick = useCallback((e, id) => {
    e.stopPropagation();
    setSel((p) => {
      const n = new Set(p);
      if (e.shiftKey) {
        n.has(id) ? n.delete(id) : n.add(id);
      } else {
        if (n.size === 1 && n.has(id)) n.clear();
        else {
          n.clear();
          n.add(id);
        }
      }
      if (n.size > 0) setModuleMode("color");
      else setModuleMode("default");
      return n;
    });
  }, []);

  /* ─── Double-click to open gradient editor ─── */
  const handleShapeDblClick = useCallback((e, id) => {
    e.stopPropagation();
    e.preventDefault();
    const svg = displayRef.current?.querySelector("svg");
    const el = svg?.getElementById(id);
    if (!el) return;

    // Pre-populate from existing fill
    const fill = el.getAttribute("fill") || "";
    if (fill.startsWith("url(#")) {
      const gid = fill.match(/url\(#([^)]+)\)/)?.[1];
      const gradEl = svg.querySelector("#" + CSS.escape(gid));
      if (gradEl) {
        const tag = gradEl.tagName.toLowerCase();
        setGradEditType(tag === "radialgradient" ? "radial" : "linear");
        const stops = gradEl.querySelectorAll("stop");
        if (stops.length >= 1) setGradEditC1(stops[0].getAttribute("stop-color") || "#3b82f6");
        if (stops.length >= 2) setGradEditC2(stops[stops.length - 1].getAttribute("stop-color") || "#8b5cf6");
        if (tag === "lineargradient") {
          const x1 = parseFloat(gradEl.getAttribute("x1")) || 0;
          const y1 = parseFloat(gradEl.getAttribute("y1")) || 0;
          const x2 = parseFloat(gradEl.getAttribute("x2")) || 100;
          const y2 = parseFloat(gradEl.getAttribute("y2")) || 0;
          const rad = Math.atan2(y2 - y1, x2 - x1);
          setGradEditAngle(Math.round((rad * 180) / Math.PI + 90));
        }
      }
    } else {
      // Solid — use it as start color, derive end
      const c = fill || "#3b82f6";
      setGradEditC1(c);
      setGradEditC2("#8b5cf6");
      setGradEditType("linear");
      setGradEditAngle(135);
    }

    setSel(new Set([id]));
    setGradEditTarget(id);
    setModuleMode("color");
  }, []);

  useEffect(() => {
    const svg = displayRef.current?.querySelector("svg");
    if (!svg) return;
    shapes.forEach((s) => {
      const el = svg.getElementById(s.id);
      if (!el) return;
      el.style.cursor = "pointer";
      const isSelected = sel.has(s.id);
      el.classList.toggle("sel", isSelected);
      if (!isSelected) {
        el.setAttribute("stroke", "rgba(0,0,0,0.08)");
        el.setAttribute("stroke-width", "0.5");
      }
      el.onclick = (e) => handleShapeClick(e, s.id);
      el.ondblclick = (e) => handleShapeDblClick(e, s.id);
    });
  }, [shapes, sel, handleShapeClick, handleShapeDblClick, step, svgSource]);

  /* ─── Delete selected paths on Delete/Backspace key ─── */
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (sel.size === 0) return;
      e.preventDefault();

      const svg = displayRef.current?.querySelector("svg");
      if (!svg) return;
      const toRemove = [...sel];
      toRemove.forEach((id) => {
        const el = svg.getElementById(id);
        if (el) el.remove();
      });

      const s = svg.outerHTML;
      setSvgSource(s);
      push(s);
      setSel(new Set());
      setGradEditTarget(null);
      setModuleMode("default");

      // Re-discover shapes
      const updated = discoverShapes(svg);
      setShapes(updated);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sel, push, discoverShapes]);

  /* ─── Fill operations ─── */
  const getCur = () => displayRef.current?.querySelector("svg")?.outerHTML || "";

  const targets = () => {
    const svg = displayRef.current?.querySelector("svg");
    if (!svg) return [];
    const ids = sel.size > 0 ? [...sel] : shapes.map((s) => s.id);
    return ids.map((id) => svg.getElementById(id)).filter(Boolean);
  };

  const applyFill = (v) => {
    targets().forEach((el) => el.setAttribute("fill", v));
    const s = getCur();
    setSvgSource(s);
    push(s);
  };

  const mkGrad = (type, c1, c2, angle) => {
    const svg = displayRef.current?.querySelector("svg");
    if (!svg) return null;
    const defs = svg.querySelector("defs");
    const id = "ug1";
    const old = defs.querySelector("#" + id);
    if (old) old.remove();
    const ns = "http://www.w3.org/2000/svg";
    let g;
    if (type === "linear") {
      g = document.createElementNS(ns, "linearGradient");
      const r = (angle * Math.PI) / 180;
      g.setAttribute("x1", 50 - Math.cos(r) * 50 + "%");
      g.setAttribute("y1", 50 - Math.sin(r) * 50 + "%");
      g.setAttribute("x2", 50 + Math.cos(r) * 50 + "%");
      g.setAttribute("y2", 50 + Math.sin(r) * 50 + "%");
    } else {
      g = document.createElementNS(ns, "radialGradient");
      g.setAttribute("cx", "50%");
      g.setAttribute("cy", "50%");
      g.setAttribute("r", "50%");
    }
    g.setAttribute("id", id);
    g.setAttribute("gradientUnits", "objectBoundingBox");
    const a = hex2rgb(c1),
      b = hex2rgb(c2);
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      const cc = lerp(a, b, t);
      const st = document.createElementNS(ns, "stop");
      st.setAttribute("offset", Math.round(t * 100) + "%");
      st.setAttribute("stop-color", rgb2hex(cc));
      g.appendChild(st);
    }
    defs.appendChild(g);
    return "url(#" + id + ")";
  };

  const applySolid = (c) => {
    setSolidClr(c);
    setMode("solid");
    applyFill(c);
  };
  const applyGrad = useCallback(() => {
    const u = mkGrad(gType, gStart, gEnd, gAngle);
    if (u) applyFill(u);
  }, [gType, gStart, gEnd, gAngle]);

  /* ─── Apply gradient from double-click editor ─── */
  const applyGradEdit = useCallback(() => {
    if (!gradEditTarget) return;
    const svg = displayRef.current?.querySelector("svg");
    const el = svg?.getElementById(gradEditTarget);
    if (!el || !svg) return;

    let defs = svg.querySelector("defs");
    if (!defs) {
      defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
      svg.prepend(defs);
    }
    const gid = "ge_" + gradEditTarget;
    const old = defs.querySelector("#" + CSS.escape(gid));
    if (old) old.remove();

    const ns = "http://www.w3.org/2000/svg";
    let g;
    if (gradEditType === "linear") {
      g = document.createElementNS(ns, "linearGradient");
      const r = (gradEditAngle * Math.PI) / 180;
      g.setAttribute("x1", 50 - Math.cos(r) * 50 + "%");
      g.setAttribute("y1", 50 - Math.sin(r) * 50 + "%");
      g.setAttribute("x2", 50 + Math.cos(r) * 50 + "%");
      g.setAttribute("y2", 50 + Math.sin(r) * 50 + "%");
    } else {
      g = document.createElementNS(ns, "radialGradient");
      g.setAttribute("cx", "50%");
      g.setAttribute("cy", "50%");
      g.setAttribute("r", "50%");
    }
    g.setAttribute("id", gid);
    g.setAttribute("gradientUnits", "objectBoundingBox");
    const a = hex2rgb(gradEditC1), b = hex2rgb(gradEditC2);
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      const cc = lerp(a, b, t);
      const st = document.createElementNS(ns, "stop");
      st.setAttribute("offset", Math.round(t * 100) + "%");
      st.setAttribute("stop-color", rgb2hex(cc));
      g.appendChild(st);
    }
    defs.appendChild(g);
    el.setAttribute("fill", "url(#" + gid + ")");

    const s = svg.outerHTML;
    setSvgSource(s);
    push(s);
  }, [gradEditTarget, gradEditType, gradEditC1, gradEditC2, gradEditAngle, push]);

  const removeGradEdit = useCallback(() => {
    if (!gradEditTarget) return;
    const svg = displayRef.current?.querySelector("svg");
    const el = svg?.getElementById(gradEditTarget);
    if (!el || !svg) return;
    el.setAttribute("fill", gradEditC1);
    const s = svg.outerHTML;
    setSvgSource(s);
    push(s);
    setGradEditTarget(null);
  }, [gradEditTarget, gradEditC1, push]);

  /* ─── Fix Me: re-colorize from validation feedback ─── */
  const fixFromValidation = useCallback(async () => {
    const svg = svgRef.current?.querySelector("svg");
    if (!svg || !originalB64Ref.current || !validation) return;

    const userNote = fixNote.trim();
    setFixing(true);
    try {
      addLog("Fix Me: rendering current SVG for comparison…");
      if (userNote) addLog(`Fix Me: user context — "${userNote}"`);
      const currentB64 = await svgToPngBase64(svg);

      const currentShapes = shapes.map((s) => {
        const el = svg.getElementById(s.id);
        return `${s.id}: <${s.tag}> fill="${el?.getAttribute("fill") || s.fill}"`;
      }).join("\n");

      const diffList = (validation.differences || []).map((d) => "- " + d).join("\n");
      const suggList = (validation.suggestions || []).map((s) => "- " + s).join("\n");
      const hints = structuralHintsRef.current;

      const fixPrompt = `You are given three things:
1. Image 1: the ORIGINAL logo (ground truth).
2. Image 2: our CURRENT SVG recreation (which has issues).
3. The current shape assignments and QA feedback below.

Previous QA score: ${validation.score}/10 (${validation.colorAccuracy || "n/a"})
Assessment: ${validation.assessment || "n/a"}
${diffList ? "Differences found:\n" + diffList : ""}
${suggList ? "Suggestions:\n" + suggList : ""}
${userNote ? "\n=== USER FEEDBACK (HIGHEST PRIORITY — address this first) ===\n" + userNote + "\n=== END USER FEEDBACK ===\n" : ""}
Current shape fills:
${currentShapes}
${hints ? "\n" + hints + "\n" : ""}
Your task: fix the color/gradient assignments so the SVG more closely matches the original logo.${userNote ? " The user has provided specific feedback above — prioritize fixing what they described." : " Pay close attention to the differences noted above."} Reassign fills to correct the issues.

Return EXACT JSON (no code fences) with key "assignments": an array where each entry has:
- "shapeId": the path ID label (e.g. "s0", "s1")
- "fill": hex color string (e.g. "#253854") for solid fills
- "gradient": null for solid fills, OR { "type": "linear"|"radial", "angle": 0-360, "stops": [{"offset":"0%","color":"#hex"},{"offset":"100%","color":"#hex"}] } for gradient fills

Every shape MUST have an assignment. Return EXACT JSON only.`;

      addLog("Fix Me: sending to GPT with QA feedback…");
      captureDebug("gpt_request", "Fix: Re-Colorize — Request", { score: validation.score, userNote: userNote || "(none)", promptLength: fixPrompt.length });
      const colorData = await callGPT({
        imageBase64: originalB64Ref.current,
        mimeType: originalMimeRef.current,
        imageBase64_2: currentB64,
        mimeType2: "image/png",
        customPrompt: fixPrompt,
      });
      addGptResponse("Fix: Re-Colorize", colorData, `Fix color assignments based on QA feedback (score: ${validation.score}/10).${fixNote.trim() ? " User note: " + fixNote.trim() : ""}`);

      const assignments = colorData.assignments || [];
      addLog(`Fix Me: received ${assignments.length} updated assignments`);

      let gradCount = 0;
      assignments.forEach((a, ai) => {
        const el = svg.getElementById(a.shapeId);
        if (!el) return;
        if (a.gradient && a.gradient.stops?.length >= 2) {
          const ref = createSvgGradient(svg, a.gradient, "fx" + ai);
          el.setAttribute("fill", ref);
          gradCount++;
        } else if (a.fill) {
          el.setAttribute("fill", a.fill);
        }
      });

      addLog(`Fix Me: applied ${assignments.length} fills (${gradCount} gradient${gradCount !== 1 ? "s" : ""})`);

      const fixedSvg = svg.outerHTML;
      debugRef.current.finalSvg = fixedSvg;
      captureDebug("info", "Fixed SVG Created", { sizeKB: (fixedSvg.length / 1024).toFixed(1) });
      setSvgSource(fixedSvg);
      push(fixedSvg);

      const updatedShapes = discoverShapes(svg);
      setShapes(updatedShapes);

      // Re-validate
      addLog("Fix Me: re-validating…");
      const recoloredB64 = await svgToPngBase64(svg);
      const validatePrompt = `Compare these two images. Image 1 is the original logo. Image 2 is our SVG vector recreation with colors re-assigned by AI after a fix attempt.

Rate the accuracy of the recreation and provide feedback.

Return EXACT JSON (no code fences) with:
- "score": number 1-10 (10 = perfect match)
- "assessment": 1-2 sentences describing the overall accuracy
- "colorAccuracy": "excellent" | "good" | "fair" | "poor"
- "differences": array of brief strings noting any color/gradient differences (empty if perfect)
- "suggestions": array of brief improvement suggestions (empty if none)

Return EXACT JSON only.`;

      const valData = await callGPT({
        imageBase64: originalB64Ref.current,
        mimeType: originalMimeRef.current,
        imageBase64_2: recoloredB64,
        mimeType2: "image/png",
        customPrompt: validatePrompt,
      });

      setValidation(valData);
      addGptResponse("Fix: Re-Validate", valData, "Re-validate the fixed SVG recreation against original.");
      setFixNote("");
      addLog(`Fix Me: new score ${valData.score}/10 — ${valData.colorAccuracy || "n/a"}`);
    } catch (e) {
      const msg = e.name === "AbortError" ? "Fix timed out." : e.message;
      addLog(`WARNING: Fix failed — ${msg}`);
    } finally {
      setFixing(false);
    }
  }, [validation, shapes, fixNote, addLog, addGptResponse, callGPT, createSvgGradient, push, discoverShapes]);

  const undo = () => {
    if (hIdx <= 0) return;
    setHIdx(hIdx - 1);
    setSvgSource(history[hIdx - 1]);
  };
  const redo = () => {
    if (hIdx >= history.length - 1) return;
    setHIdx(hIdx + 1);
    setSvgSource(history[hIdx + 1]);
  };

  const cleanClone = () => {
    const svg = displayRef.current?.querySelector("svg");
    if (!svg) return null;
    const cl = svg.cloneNode(true);
    cl.querySelectorAll(".sel").forEach((e) => e.classList.remove("sel"));
    // Remove editor strokes from export
    cl.querySelectorAll("[stroke]").forEach((e) => {
      if (e.getAttribute("stroke")?.startsWith("rgba(0,0,0,0.0")) {
        e.removeAttribute("stroke");
        e.removeAttribute("stroke-width");
      }
    });
    cl.style.cssText = "";
    if (!cl.getAttribute("xmlns"))
      cl.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    return cl;
  };

  const download = () => {
    const cl = cleanClone();
    if (!cl) return;
    const t = new XMLSerializer().serializeToString(cl);
    const b = new Blob([t], { type: "image/svg+xml" });
    const u = URL.createObjectURL(b);
    const a = document.createElement("a");
    a.href = u;
    a.download = "logo-edited.svg";
    a.click();
    URL.revokeObjectURL(u);
  };

  const copySvg = () => {
    const cl = cleanClone();
    if (!cl) return;
    const t = new XMLSerializer().serializeToString(cl);
    navigator.clipboard
      .writeText(t)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  };

  const handleFile = (f) => {
    if (!f) return;
    processFile(f);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    handleFile(e.dataTransfer.files[0]);
  };

  const startOver = () => {
    setStep("idle");
    setSvgSource("");
    setHistory([]);
    setHIdx(-1);
    setShapes([]);
    setSel(new Set());
    setAnalysis(null);
    setValidation(null);
    setAnalysisReport(null);
    setVersions(null);
    setActiveVersionTab(null);
    registriesRef.current = null;
    setShowDebugPanel(false);
    setGradEditTarget(null);
    setFixing(false);
    setFixNote("");
    resetDebug();
    setShowGptDebug(false);
    setModuleMode("default");
    setFileMeta(null);
    setError("");
    setPreview(null);
  };

  const isProcessing = step === "uploading" || step === "vectorizing" || step === "analyzing";
  const isReady = step === "ready";
  const selCount = sel.size;
  const tgtLabel =
    selCount > 0
      ? `${selCount} shape${selCount > 1 ? "s" : ""}`
      : "all shapes";

  const statusMsg = {
    uploading: "Reading file…",
    analyzing: "Analyzing brand identity…",
    vectorizing: "Vectorizing outlines…",
  };

  // Derive brand color (dominant non-neutral from analysis)
  const brandColor = useMemo(() => {
    if (!analysis?.colors?.length) return "#000000";
    const neutrals = new Set(["#000000", "#ffffff", "#fff", "#000", "#333333", "#666666", "#999999", "#cccccc", "#9a9a9a"]);
    const nonNeutral = analysis.colors.find((c) => !neutrals.has(c.toLowerCase()));
    return nonNeutral || analysis.colors[0];
  }, [analysis]);

  // Toggle helpers for score/debug badges
  const toggleAccuracy = () => {
    setModuleMode((m) => m === "accuracy" ? (sel.size > 0 ? "color" : "default") : "accuracy");
  };
  const toggleDebug = () => {
    const db = debugRef.current;
    const bundle = {
      exportedAt: new Date().toISOString(),
      file: { name: db.uploadedFileName, size: db.uploadedFileSize, mime: db.uploadedMime },
      uploadedFileDataUrl: db.uploadedFile || null,
      vectorizerSvg: db.vectorizerSvg || null,
      finalSvg: db.finalSvg || svgSource || null,
      events: db.events,
      pipelineLogs: logs,
      analysisReport: analysisReport || null,
      validation: validation || null,
      analysis: analysis || null,
      versions: versions ? versions.map(v => ({ id: v.id, label: v.label, palette: v.palette, maxColors: v.maxColors })) : null,
    };
    const json = JSON.stringify(bundle, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `merchai-debug-${db.uploadedFileName || "export"}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const deselectAndReturn = () => {
    setSel(new Set());
    setGradEditTarget(null);
    setModuleMode("default");
  };

  return (
    <>
      <Head>
        <title>Merch.ai - Logo Analyzer</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600&family=JetBrains+Mono:wght@400&display=swap"
          rel="stylesheet"
        />
      </Head>

      <style jsx global>{`
        @font-face {
          font-family: 'Bouba Round';
          src: url('/BoubaRound.otf') format('opentype');
          font-weight: normal;
          font-style: normal;
          font-display: swap;
        }
        *, *::before, *::after { box-sizing: border-box; margin: 0; }
        html { background: #f5f4f0; color: #1a1a1a; }
        body { font-family: "Bouba Round", "DM Sans", sans-serif; -webkit-font-smoothing: antialiased; }
        .sel {
          stroke: #e85d26 !important;
          stroke-width: 1.5px !important;
          stroke-dasharray: none !important;
          filter: drop-shadow(0 0 4px rgba(232, 93, 38, 0.4)) !important;
        }
        input[type="color"] {
          -webkit-appearance: none; border: 1px solid #ddd;
          width: 36px; height: 36px; border-radius: 8px; cursor: pointer; padding: 0; overflow: hidden; background: transparent;
        }
        input[type="color"]::-webkit-color-swatch-wrapper { padding: 0; }
        input[type="color"]::-webkit-color-swatch { border: none; border-radius: 7px; }
        input[type="range"] {
          -webkit-appearance: none; background: #e5e4e0; height: 3px; border-radius: 2px; outline: none; width: 100%;
        }
        input[type="range"]::-webkit-slider-thumb {
          -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%; background: #e85d26; cursor: pointer;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
        .fade-up { animation: fadeUp 0.5s ease both; }
        @media (max-width: 640px) {
          .app-header { padding: 10px 16px !important; }
          .header-actions { gap: 4px !important; }
          .header-actions .hdr-btn { font-size: 12px !important; padding: 5px 8px !important; }
          .upload-title { font-size: 22px !important; margin-bottom: 16px !important; }
          .upload-zone { padding: 36px 20px !important; }
          .processing-main { flex-direction: column !important; gap: 20px !important; padding: 16px !important; }
          .shirt-stage { min-height: 320px !important; }
          .module-container { margin: 0 8px 20px !important; }
        }
      `}</style>

      {/* Hidden SVG workspace */}
      <div ref={svgRef} style={{ position: "absolute", left: -9999, top: -9999, width: 600, height: 600, visibility: "hidden" }} />

      <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>

        {/* ═══════════════ HEADER ═══════════════ */}
        <header
          className="app-header"
          style={{
            padding: "12px 24px",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            background: "#fff",
            borderBottom: "1px solid #eeede9",
            position: "relative",
            minHeight: 52,
          }}
        >
          {/* Left: logo + brand */}
          <div style={{ position: "absolute", left: 24, display: "flex", alignItems: "center", gap: 12, cursor: "pointer" }} onClick={startOver}>
            <img src="/merchai-logo.svg" alt="Merch.ai" style={{ height: 28 }} />
            <div style={{ display: "flex", alignItems: "center", gap: 10, fontFamily: "'DM Sans', sans-serif" }}>
              <span style={{ fontSize: 17, fontWeight: 600, letterSpacing: ".1em", color: "#253854", textTransform: "uppercase" }}>MERCH AI</span>
              <span style={{ color: "#ccc", fontSize: 17, fontWeight: 300 }}>|</span>
              <span style={{ fontSize: 15, fontWeight: 400, letterSpacing: ".1em", color: "#999" }}>aaker</span>
            </div>
          </div>

          {/* Center spacer for balance */}
          <div style={{ width: 1 }} />

          {/* Right: actions */}
          {isReady && (
            <div className="header-actions" style={{ position: "absolute", right: 24, display: "flex", gap: 8 }}>
              <button className="hdr-btn" onClick={undo} disabled={hIdx <= 0}
                style={{ padding: "6px 10px", borderRadius: 6, border: "none", background: "transparent", color: hIdx <= 0 ? "#ccc" : "#666", fontSize: 13, fontFamily: "'DM Sans', sans-serif", cursor: hIdx <= 0 ? "default" : "pointer" }}>
                Undo
              </button>
              <button className="hdr-btn" onClick={redo} disabled={hIdx >= history.length - 1}
                style={{ padding: "6px 10px", borderRadius: 6, border: "none", background: "transparent", color: hIdx >= history.length - 1 ? "#ccc" : "#666", fontSize: 13, fontFamily: "'DM Sans', sans-serif", cursor: hIdx >= history.length - 1 ? "default" : "pointer" }}>
                Redo
              </button>
              <button className="hdr-btn" onClick={startOver}
                style={{ padding: "6px 10px", borderRadius: 6, border: "none", background: "transparent", color: "#666", fontSize: 13, fontFamily: "'DM Sans', sans-serif", cursor: "pointer" }}>
                New Logo
              </button>
            </div>
          )}
        </header>

        {/* ═══════════════ IDLE: Upload ═══════════════ */}
        {step === "idle" && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "16px 32px 32px", gap: 0, overflow: "hidden" }}>
            {/* Mascot */}
            <img
              src="/landing.png"
              alt="Merch.ai mascot"
              style={{
                width: "100%",
                maxWidth: "min(50vw, 420px)",
                height: "auto",
                objectFit: "contain",
                flexShrink: 1,
                minHeight: 0,
              }}
            />
            <div className="fade-up" style={{ maxWidth: 480, width: "100%", textAlign: "center", flexShrink: 0 }}>
              <h1 className="upload-title" style={{ fontFamily: "'Bouba Round', sans-serif", fontSize: 28, fontWeight: 400, lineHeight: 1.1, marginBottom: 24, color: "#1a1a1a" }}>
                Upload your logo
              </h1>
              <div
                className="upload-zone"
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileRef.current?.click()}
                style={{
                  border: `2px dashed ${dragOver ? "#e85d26" : "#d5d4d0"}`,
                  borderRadius: 20, padding: "56px 32px", cursor: "pointer",
                  transition: "all .2s", background: dragOver ? "rgba(232,93,38,.03)" : "#fff",
                }}
              >
                <div style={{ fontSize: 36, marginBottom: 8, opacity: 0.2 }}>{"\u2191"}</div>
                <div style={{ fontSize: 15, color: "#666", marginBottom: 4 }}>
                  Drag & drop or <span style={{ color: "#e85d26", fontWeight: 500 }}>browse</span>
                </div>
                <div style={{ fontSize: 13, color: "#aaa" }}>PNG, JPG, SVG — max 10MB</div>
              </div>
              <input ref={fileRef} type="file" accept="image/*,.svg" style={{ display: "none" }} onChange={(e) => handleFile(e.target.files[0])} />
              {error && (
                <div style={{ marginTop: 16, padding: "10px 16px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, fontSize: 13, color: "#dc2626" }}>
                  {error}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ═══════════════ PROCESSING ═══════════════ */}
        {isProcessing && (
          <div className="fade-up" style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", minHeight: 0, padding: "32px 16px" }}>
            <div className="processing-main" style={{ display: "flex", gap: 48, alignItems: "center", maxWidth: 700 }}>
              {/* Left: Loading info */}
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, minWidth: 200 }}>
                {preview && (
                  <div style={{ width: 64, height: 64, borderRadius: 12, overflow: "hidden", border: "1px solid rgba(0,0,0,.08)", background: "#fff" }}>
                    <img src={preview} alt="" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
                  </div>
                )}
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 18, height: 18, border: "2.5px solid #eee", borderTopColor: "#e85d26", borderRadius: "50%", animation: "spin .6s linear infinite" }} />
                  <div style={{ fontSize: 15, color: "#555", fontWeight: 500 }}>{statusMsg[step]}</div>
                </div>
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "#bbb" }}>{elapsed}s elapsed</div>

                {/* Stepper */}
                <div style={{ display: "flex", gap: 16, marginTop: 4 }}>
                  {["Analysis", "Colorize", "Validate"].map((label, i) => {
                    const stepIdx = step === "analyzing" ? 0 : step === "vectorizing" ? 1 : 2;
                    const isActive = i <= stepIdx;
                    return (
                      <div key={label} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <div style={{
                          width: 18, height: 18, borderRadius: "50%", fontSize: 10, fontWeight: 600,
                          display: "flex", alignItems: "center", justifyContent: "center",
                          background: isActive ? "#e85d26" : "#e5e4e0", color: isActive ? "#fff" : "#aaa",
                        }}>{i + 1}</div>
                        <span style={{ fontSize: 11, color: isActive ? "#555" : "#ccc" }}>{label}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Right: Game */}
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                <div style={{ fontSize: 11, color: "#bbb", marginBottom: 6 }}>Play while you wait!</div>
                <WaitGame />
              </div>
            </div>
          </div>
        )}

        {/* ═══════════════ READY ═══════════════ */}
        {isReady && (
          <div className="fade-up" style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center" }}>

            {/* ─── T-Shirt Stage ─── */}
            <div
              className="shirt-stage"
              style={{
                position: "relative",
                width: "100%",
                maxWidth: 820,
                margin: "0 auto",
                borderRadius: 0,
                overflow: "hidden",
                background: "#f5f4f0",
                minHeight: 420,
              }}
              onClick={(e) => {
                // Click on stage background = deselect
                if (e.target === e.currentTarget || e.target.tagName === "IMG") {
                  deselectAndReturn();
                }
              }}
            >
              {/* Shirt background */}
              <img src="/Shirt.jpg" alt="" style={{ width: "100%", display: "block" }} />

              {/* Logo overlay — centered in safe area */}
              <div style={{
                position: "absolute",
                top: "18%",
                left: "15%",
                right: "15%",
                bottom: "8%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                pointerEvents: "none",
              }}>
                <div
                  ref={displayRef}
                  className="logo-display"
                  style={{
                    maxWidth: "85%",
                    maxHeight: "85%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    pointerEvents: "auto",
                  }}
                />
              </div>

              {/* Score badge — top right */}
              {validation && (
                <div
                  onClick={toggleAccuracy}
                  style={{
                    position: "absolute",
                    top: 16,
                    right: 16,
                    width: 44,
                    height: 44,
                    borderRadius: 12,
                    background: validation.score >= 7 ? "#22c55e" : validation.score >= 4 ? "#f59e0b" : "#ef4444",
                    color: "#fff",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontWeight: 700,
                    fontSize: 20,
                    fontFamily: "'JetBrains Mono', monospace",
                    cursor: "pointer",
                    boxShadow: "0 2px 12px rgba(0,0,0,.15)",
                    transition: "transform .15s",
                    border: moduleMode === "accuracy" ? "2px solid #fff" : "none",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.transform = "scale(1.08)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.transform = "scale(1)"; }}
                >
                  {validation.score}
                </div>
              )}

              {/* Versions badge — top right, below score */}
              {versions && versions.length > 0 && (() => {
                const approvedCount = versions.filter((v) => versionApprovals[v.id] === "approved").length;
                const allDone = approvedCount === versions.length;
                return (
                  <div
                    onClick={() => setModuleMode((m) => m === "versions" ? "default" : "versions")}
                    title="Logo versions — click to review"
                    style={{
                      position: "absolute",
                      top: validation ? 68 : 16,
                      right: 16,
                      height: 32,
                      paddingLeft: 10,
                      paddingRight: 10,
                      borderRadius: 8,
                      background: allDone ? "#22c55e" : moduleMode === "versions" ? "#e85d26" : "#fff",
                      color: allDone ? "#fff" : moduleMode === "versions" ? "#fff" : "#666",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontWeight: 600,
                      fontSize: 12,
                      fontFamily: "'DM Sans', sans-serif",
                      cursor: "pointer",
                      boxShadow: "0 2px 12px rgba(0,0,0,.1)",
                      transition: "transform .15s, background .15s",
                      border: "1px solid " + (allDone ? "#22c55e" : moduleMode === "versions" ? "#e85d26" : "#e5e4e0"),
                      gap: 5,
                      letterSpacing: ".03em",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.transform = "scale(1.05)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.transform = "scale(1)"; }}
                  >
                    {allDone ? "\u2713 Versions" : `Versions ${approvedCount}/${versions.length}`}
                  </div>
                );
              })()}

              {/* Bug icon — bottom right — downloads debug bundle */}
              <div
                onClick={toggleDebug}
                title="Download debug bundle"
                style={{
                  position: "absolute",
                  bottom: 16,
                  right: 16,
                  width: 36,
                  height: 36,
                  cursor: "pointer",
                  opacity: 0.5,
                  transition: "opacity .15s",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; }}
                onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.5"; }}
              >
                <img src="/bug.svg" alt="Debug" style={{ width: 28, height: 28 }} />
              </div>
            </div>

            {/* ─── Module Container ─── */}
            <div className="module-container" style={{
              width: "100%",
              maxWidth: 820,
              margin: "16px auto 32px",
              padding: "0 16px",
            }}>

              {/* ══════ DEFAULT MODULE: Analysis Summary ══════ */}
              {moduleMode === "default" && analysis && (
                <div className="fade-up" style={{
                  background: "#fff",
                  border: "1px solid #eeede9",
                  borderRadius: 16,
                  padding: "24px 28px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 16,
                }}>
                  {/* Description */}
                  {analysis.description && (
                    <p style={{ fontSize: 16, lineHeight: 1.7, color: "#333", margin: 0 }}>
                      {analysis.description}
                    </p>
                  )}

                  {/* Tags */}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {analysis.category && <Tag label="Category" value={analysis.category} />}
                    {analysis.complexity && <Tag label="Complexity" value={analysis.complexity} />}
                    {analysis.layout && <Tag label="Layout" value={analysis.layout} />}
                    {analysis.nestedElements != null && <Tag label="Nested" value={analysis.nestedElements ? "Yes" : "No"} />}
                  </div>

                  {/* Color palette */}
                  {analysis.colors?.length > 0 && (
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                      {analysis.colors.map((c, i) => (
                        <div key={i} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                          <div style={{ width: 18, height: 18, borderRadius: 4, background: c, border: "1px solid rgba(0,0,0,.1)" }} />
                          <Mono>{c}</Mono>
                        </div>
                      ))}
                      {analysis.mood && (
                        <span style={{ fontSize: 12, color: "#e85d26", fontWeight: 500, marginLeft: 6 }}>
                          {analysis.mood}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Gradients */}
                  {analysis.gradients?.length > 0 && (
                    <div>
                      <div style={{ fontSize: 11, color: "#999", marginBottom: 6, fontWeight: 500, textTransform: "uppercase", letterSpacing: ".05em" }}>
                        Detected Gradients
                      </div>
                      <div style={{ display: "flex", gap: 6 }}>
                        {analysis.gradients.map((g, i) => (
                          <div key={i} style={{
                            height: 24, flex: 1, minWidth: 80, borderRadius: 6, border: "1px solid #eee",
                            background: g.type === "radial"
                              ? `radial-gradient(circle, ${g.stops?.[0]?.color || "#000"}, ${g.stops?.[g.stops.length - 1]?.color || "#000"})`
                              : `linear-gradient(${g.angle || 135}deg, ${g.stops?.[0]?.color || "#000"}, ${g.stops?.[g.stops.length - 1]?.color || "#000"})`,
                          }} />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Notes */}
                  {analysis.notes && (
                    <p style={{ fontSize: 13, lineHeight: 1.6, color: "#888", margin: 0, borderTop: "1px solid #f0f0f0", paddingTop: 12 }}>
                      {analysis.notes}
                    </p>
                  )}

                  {/* Hint */}
                  <div style={{ fontSize: 12, color: "#bbb", textAlign: "center", paddingTop: 4 }}>
                    Click a shape on the logo to edit its color
                  </div>
                </div>
              )}

              {/* ══════ COLOR MODULE ══════ */}
              {moduleMode === "color" && (
                <div className="fade-up" style={{
                  background: "#fff",
                  border: "1px solid #eeede9",
                  borderRadius: 16,
                  padding: "24px 28px",
                }}>
                  {gradEditTarget ? (
                    /* Gradient editing sub-mode */
                    <div>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                        <Label style={{ marginBottom: 0 }}>GRADIENT EDITOR</Label>
                        <span style={{ fontSize: 12, color: "#bbb", cursor: "pointer" }} onClick={() => setGradEditTarget(null)}>
                          Back to Colors
                        </span>
                      </div>
                      <div style={{ fontSize: 12, color: "#999", marginBottom: 12 }}>
                        Editing: <Mono>{gradEditTarget}</Mono>
                      </div>

                      {/* Preview */}
                      <div style={{
                        height: 32, borderRadius: 8, marginBottom: 16, border: "1px solid #eee",
                        background: gradEditType === "radial"
                          ? `radial-gradient(circle, ${gradEditC1}, ${gradEditC2})`
                          : `linear-gradient(${gradEditAngle}deg, ${gradEditC1}, ${gradEditC2})`,
                      }} />

                      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
                        <div style={{ flex: 1, minWidth: 180 }}>
                          <Label>Type</Label>
                          <div style={{ display: "flex", gap: 4, marginBottom: 14 }}>
                            {["linear", "radial"].map((t) => (
                              <button key={t} onClick={() => setGradEditType(t)}
                                style={{
                                  flex: 1, padding: "6px 0", borderRadius: 6, fontSize: 12, border: "1px solid #e5e4e0",
                                  background: gradEditType === t ? "#fff7f5" : "#fff", color: gradEditType === t ? "#e85d26" : "#888",
                                  borderColor: gradEditType === t ? "#e85d26" : "#e5e4e0", cursor: "pointer", fontFamily: "'DM Sans', sans-serif",
                                }}>
                                {t}
                              </button>
                            ))}
                          </div>
                          <Label>Start Color</Label>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                            <input type="color" value={gradEditC1} onChange={(e) => setGradEditC1(e.target.value)} />
                            <Mono>{gradEditC1}</Mono>
                          </div>
                          <Label>End Color</Label>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                            <input type="color" value={gradEditC2} onChange={(e) => setGradEditC2(e.target.value)} />
                            <Mono>{gradEditC2}</Mono>
                          </div>
                          {gradEditType === "linear" && (
                            <>
                              <Label>Angle — {gradEditAngle}°</Label>
                              <input type="range" min={0} max={360} value={gradEditAngle} onChange={(e) => setGradEditAngle(+e.target.value)} style={{ marginBottom: 14 }} />
                            </>
                          )}
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 8, justifyContent: "flex-end" }}>
                          <BtnAccent onClick={applyGradEdit}>Apply Gradient</BtnAccent>
                          <Btn onClick={removeGradEdit} style={{ fontSize: 12 }}>Remove Gradient</Btn>
                        </div>
                      </div>

                      <div style={{ fontSize: 12, color: "#bbb", marginTop: 14, cursor: "pointer", textAlign: "center" }}
                        onClick={deselectAndReturn}>
                        Deselect
                      </div>
                    </div>
                  ) : (
                    /* Normal color editing */
                    <div style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
                      {/* Left: Edit Color */}
                      <div style={{ flex: 1, minWidth: 240 }}>
                        <Label>EDIT COLOR</Label>
                        <div style={{ fontSize: 11, color: "#999", marginBottom: 10, fontWeight: 500, textTransform: "uppercase", letterSpacing: ".05em" }}>
                          Change Color
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <ColorBtn color="#ffffff" label="White" onClick={() => applyFill("#ffffff")} />
                          <ColorBtn color="#000000" label="Black" onClick={() => applyFill("#000000")} />
                          {(analysis?.colors || []).map((c, i) => (
                            <ColorBtn key={i} color={c} label={c} onClick={() => applyFill(c)} />
                          ))}
                          {/* + button for custom color */}
                          <div style={{ position: "relative" }}>
                            <input type="color" onChange={(e) => applyFill(e.target.value)}
                              style={{ width: 36, height: 36, borderRadius: 8, border: "1px solid #e5e4e0", cursor: "pointer", opacity: 0, position: "absolute", inset: 0 }} />
                            <div style={{
                              width: 36, height: 36, borderRadius: 8, border: "1px solid #e5e4e0", display: "flex",
                              alignItems: "center", justifyContent: "center", fontSize: 18, color: "#ccc", cursor: "pointer", background: "#fafafa",
                            }}>+</div>
                          </div>
                        </div>
                        <div style={{ fontSize: 11, color: "#999", marginTop: 12 }}>
                          Double-click a shape for gradient editing
                        </div>
                        <div style={{ fontSize: 12, color: "#bbb", marginTop: 8, cursor: "pointer" }} onClick={deselectAndReturn}>
                          Deselect
                        </div>
                      </div>

                      {/* Right: Brand Color */}
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", minWidth: 140 }}>
                        <Label>BRAND COLOR</Label>
                        <div
                          onClick={() => applyFill(brandColor)}
                          style={{
                            width: 80, height: 80, borderRadius: 14,
                            background: brandColor, border: "1px solid rgba(0,0,0,.1)",
                            cursor: "pointer", transition: "transform .12s",
                            boxShadow: "0 2px 8px rgba(0,0,0,.08)",
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.transform = "scale(1.06)"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.transform = "scale(1)"; }}
                          title={`Apply ${brandColor}`}
                        />
                        <Mono style={{ marginTop: 8 }}>{brandColor}</Mono>
                      </div>

                      {/* Divider line */}
                      <div style={{ width: 1, background: "#eeede9", alignSelf: "stretch" }} />
                    </div>
                  )}
                </div>
              )}

              {/* ══════ ACCURACY MODULE ══════ */}
              {moduleMode === "accuracy" && validation && (
                <div className="fade-up" style={{
                  background: validation.score >= 7 ? "#f0fdf4" : validation.score >= 4 ? "#fffbeb" : "#fef2f2",
                  border: `1px solid ${validation.score >= 7 ? "#bbf7d0" : validation.score >= 4 ? "#fde68a" : "#fecaca"}`,
                  borderRadius: 16,
                  padding: "24px 28px",
                }}>
                  {/* Header row */}
                  <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16 }}>
                    <div style={{
                      width: 44, height: 44, borderRadius: 12,
                      background: validation.score >= 7 ? "#22c55e" : validation.score >= 4 ? "#f59e0b" : "#ef4444",
                      color: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
                      fontWeight: 700, fontSize: 20, fontFamily: "'JetBrains Mono', monospace",
                    }}>
                      {validation.score}
                    </div>
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 600, color: "#333" }}>Recreation Accuracy</div>
                      <div style={{ fontSize: 13, color: "#888" }}>
                        Color: <span style={{ fontWeight: 500, color: "#666" }}>{validation.colorAccuracy || "n/a"}</span>
                      </div>
                    </div>
                  </div>

                  {/* Assessment */}
                  {validation.assessment && (
                    <p style={{ fontSize: 14, lineHeight: 1.6, color: "#444", margin: "0 0 12px" }}>
                      {validation.assessment}
                    </p>
                  )}

                  {/* Differences */}
                  {validation.differences?.length > 0 && (
                    <div style={{ marginBottom: 16 }}>
                      {validation.differences.map((d, i) => (
                        <div key={i} style={{ paddingLeft: 10, borderLeft: "2px solid #ddd", marginBottom: 6, fontSize: 13, color: "#666", lineHeight: 1.5 }}>
                          {d}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Fix Me textarea + button */}
                  <textarea
                    value={fixNote}
                    onChange={(e) => setFixNote(e.target.value)}
                    disabled={fixing}
                    placeholder="Describe what looks wrong… (optional)"
                    style={{
                      width: "100%", minHeight: 60, padding: "10px 12px", borderRadius: 10,
                      border: "1px solid #e5e4e0", background: "#fff", color: "#333", fontSize: 13,
                      fontFamily: "'DM Sans', sans-serif", lineHeight: 1.5, resize: "vertical",
                      outline: "none", transition: "border-color .15s", marginBottom: 10,
                    }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = "#e85d26"; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = "#e5e4e0"; }}
                  />
                  <button
                    onClick={fixFromValidation}
                    disabled={fixing}
                    style={{
                      width: "100%", padding: "10px 0", borderRadius: 10,
                      border: "1px solid #e5e4e0", background: fixing ? "#f5f4f2" : "#fff",
                      color: fixing ? "#aaa" : "#e85d26", fontSize: 14, fontWeight: 600,
                      fontFamily: "'DM Sans', sans-serif", cursor: fixing ? "default" : "pointer",
                      transition: "all .15s", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                    }}
                    onMouseEnter={(e) => { if (!fixing) e.currentTarget.style.background = "#fff7f5"; }}
                    onMouseLeave={(e) => { if (!fixing) e.currentTarget.style.background = fixing ? "#f5f4f2" : "#fff"; }}
                  >
                    {fixing && (
                      <span style={{
                        width: 16, height: 16, border: "2px solid #eee", borderTopColor: "#e85d26",
                        borderRadius: "50%", animation: "spin .6s linear infinite", display: "inline-block",
                      }} />
                    )}
                    {fixing ? "Fixing…" : "Fix Me"}
                  </button>
                </div>
              )}

              {/* ══════ VERSIONS MODULE ══════ */}
              {moduleMode === "versions" && versions && versions.length > 0 && (() => {
                const activeVersion = versions.find((v) => v.id === activeVersionTab) || versions[0];
                const approvedCount = versions.filter((v) => versionApprovals[v.id] === "approved").length;
                const reviewedCount = versions.filter((v) => versionApprovals[v.id]).length;
                const allApproved = approvedCount === versions.length;
                const activeStatus = versionApprovals[activeVersion.id];
                const baseName = (debugRef.current.uploadedFileName || "logo").replace(/\.[^.]+$/, "");

                const versionDescriptions = {
                  v_full: "Original colorized SVG with all colors and gradients preserved",
                  v_3to5: "Quantized to 3-5 ink colors — for screen printing and merch",
                  v_2: "Two-color version — primary + secondary ink only",
                  v_1: "Single-color version — one ink for stamps, embossing, mono prints",
                };

                const versionFileNames = {
                  v_full: "full-color",
                  v_3to5: "3-5-color",
                  v_2: "2-color",
                  v_1: "1-color",
                };

                const downloadVersion = (v) => {
                  downloadFile(`${baseName}-${versionFileNames[v.id] || v.id}.svg`, new TextEncoder().encode(v.svgString), "image/svg+xml");
                };

                const downloadAllApproved = () => {
                  const approved = versions.filter((v) => versionApprovals[v.id] === "approved");
                  if (approved.length === 0) return;
                  const files = [];
                  for (const v of approved) {
                    files.push({ name: `${baseName}-${versionFileNames[v.id] || v.id}.svg`, data: new TextEncoder().encode(v.svgString) });
                  }
                  const zip = buildZip(files);
                  downloadFile(`${baseName}-logo-versions.zip`, zip, "application/zip");
                };

                return (
                  <div className="fade-up" style={{
                    background: "#fff",
                    border: "1px solid #eeede9",
                    borderRadius: 16,
                    padding: "24px 28px",
                  }}>
                    {/* Header */}
                    <div style={{ marginBottom: 16 }}>
                      <div style={{ fontSize: 15, fontWeight: 700, color: "#222", marginBottom: 2 }}>
                        Logo Versions
                      </div>
                      <div style={{ fontSize: 12, color: "#999" }}>
                        Review and approve each color version for production use
                      </div>
                    </div>

                    {/* Progress */}
                    <div style={{ marginBottom: 18 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: allApproved ? "#22c55e" : "#333" }}>
                          {allApproved ? "All 4 versions approved" : `${approvedCount} of ${versions.length} approved`}
                        </span>
                        <span style={{ fontSize: 11, color: "#999" }}>
                          {reviewedCount < versions.length
                            ? `${versions.length - reviewedCount} to review`
                            : allApproved ? "Ready to export" : `${versions.length - approvedCount} need attention`}
                        </span>
                      </div>
                      <div style={{ height: 6, borderRadius: 3, background: "#f0efec", overflow: "hidden" }}>
                        <div style={{
                          height: "100%", borderRadius: 3,
                          width: `${(approvedCount / versions.length) * 100}%`,
                          background: allApproved ? "#22c55e" : "#e85d26",
                          transition: "width .3s ease, background .3s ease",
                        }} />
                      </div>
                    </div>

                    {/* Step tabs: Full → 3-5 → 2 → 1 */}
                    <div style={{ display: "flex", gap: 0, marginBottom: 16, position: "relative" }}>
                      {versions.map((v, idx) => {
                        const vst = versionApprovals[v.id];
                        const isActive = activeVersionTab === v.id;
                        const stepNum = idx + 1;
                        return (
                          <button
                            key={v.id}
                            onClick={() => setActiveVersionTab(v.id)}
                            style={{
                              flex: 1, padding: "10px 4px 8px", borderRadius: 0,
                              borderBottom: isActive ? "3px solid #e85d26" : "3px solid transparent",
                              fontSize: 11, fontWeight: isActive ? 700 : 400,
                              background: "transparent",
                              color: isActive ? "#e85d26" : vst === "approved" ? "#22c55e" : vst === "rejected" ? "#ef4444" : "#888",
                              cursor: "pointer", fontFamily: "'DM Sans', sans-serif", transition: "all .15s",
                              display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
                              border: "none", borderBottomWidth: 3, borderBottomStyle: "solid",
                              borderBottomColor: isActive ? "#e85d26" : "transparent",
                            }}
                          >
                            <span style={{
                              width: 22, height: 22, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
                              fontSize: 11, fontWeight: 700,
                              background: vst === "approved" ? "#22c55e" : vst === "rejected" ? "#ef4444" : isActive ? "#e85d26" : "#e5e4e0",
                              color: vst || isActive ? "#fff" : "#888",
                            }}>
                              {vst === "approved" ? "\u2713" : vst === "rejected" ? "\u2717" : stepNum}
                            </span>
                            <span>{v.label}</span>
                          </button>
                        );
                      })}
                    </div>

                    {/* Version description */}
                    <div style={{
                      fontSize: 12, color: "#777", marginBottom: 12, padding: "8px 12px",
                      background: "#fafaf8", borderRadius: 8, borderLeft: "3px solid #e85d26",
                    }}>
                      {versionDescriptions[activeVersion.id] || ""}
                    </div>

                    {/* SVG preview */}
                    <div
                      style={{
                        background: "#f8f8f6", borderRadius: 12, padding: 20,
                        textAlign: "center", minHeight: 140,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        border: activeStatus === "approved" ? "2px solid #bbf7d0" : activeStatus === "rejected" ? "2px solid #fecaca" : "1px solid #eee",
                      }}
                      dangerouslySetInnerHTML={{
                        __html: activeVersion.svgString.replace(/<svg/, '<svg style="max-width:100%;max-height:220px;"'),
                      }}
                    />

                    {/* Palette */}
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 14, paddingBottom: 14, borderBottom: "1px solid #f0efec" }}>
                      <span style={{ fontSize: 11, color: "#999", fontWeight: 500, textTransform: "uppercase", letterSpacing: ".05em" }}>
                        Palette
                      </span>
                      {activeVersion.palette.map((hex, i) => (
                        <div key={i} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                          <div style={{ width: 18, height: 18, borderRadius: 4, background: hex, border: "1px solid rgba(0,0,0,.1)" }} />
                          <span style={{ fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: "#666" }}>{hex}</span>
                        </div>
                      ))}
                      <span style={{ fontSize: 11, color: "#bbb", marginLeft: "auto" }}>
                        {activeVersion.maxColors === Infinity
                          ? `${activeVersion.palette.length} color${activeVersion.palette.length !== 1 ? "s" : ""} (full)`
                          : `${activeVersion.palette.length} ink color${activeVersion.palette.length !== 1 ? "s" : ""}`}
                      </span>
                    </div>

                    {/* Approve / Reject */}
                    {(() => {
                      const curIdx = versions.findIndex((v) => v.id === activeVersion.id);
                      const advanceToNext = () => {
                        // Go to next sequential version that hasn't been reviewed yet, or just the next one
                        for (let i = curIdx + 1; i < versions.length; i++) {
                          if (!versionApprovals[versions[i].id]) {
                            setActiveVersionTab(versions[i].id);
                            return;
                          }
                        }
                        // If all after are reviewed, find any unreviewed
                        const unreviewed = versions.find((v) => v.id !== activeVersion.id && !versionApprovals[v.id]);
                        if (unreviewed) setActiveVersionTab(unreviewed.id);
                      };
                      const isLast = !versions.some((v) => v.id !== activeVersion.id && !versionApprovals[v.id]);

                      return (
                        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                          {activeStatus === "approved" ? (
                            <button
                              onClick={() => setVersionApprovals((prev) => { const n = { ...prev }; delete n[activeVersion.id]; return n; })}
                              style={{
                                flex: 1, padding: "10px 0", borderRadius: 10,
                                border: "1px solid #bbf7d0", background: "#f0fdf4", color: "#22c55e",
                                fontSize: 13, fontWeight: 500, fontFamily: "'DM Sans', sans-serif", cursor: "pointer",
                              }}
                            >
                              {"\u2713"} Approved — click to undo
                            </button>
                          ) : activeStatus === "rejected" ? (
                            <button
                              onClick={() => setVersionApprovals((prev) => { const n = { ...prev }; delete n[activeVersion.id]; return n; })}
                              style={{
                                flex: 1, padding: "10px 0", borderRadius: 10,
                                border: "1px solid #fecaca", background: "#fef2f2", color: "#ef4444",
                                fontSize: 13, fontWeight: 500, fontFamily: "'DM Sans', sans-serif", cursor: "pointer",
                              }}
                            >
                              {"\u2717"} Rejected — click to undo
                            </button>
                          ) : (
                            <>
                              <button
                                onClick={() => {
                                  setVersionApprovals((prev) => ({ ...prev, [activeVersion.id]: "rejected" }));
                                  advanceToNext();
                                }}
                                style={{
                                  flex: "0 0 auto", padding: "10px 20px", borderRadius: 10,
                                  border: "1px solid #fecaca", background: "#fff", color: "#ef4444",
                                  fontSize: 13, fontWeight: 600, fontFamily: "'DM Sans', sans-serif", cursor: "pointer",
                                  transition: "background .15s",
                                }}
                                onMouseEnter={(e) => { e.currentTarget.style.background = "#fef2f2"; }}
                                onMouseLeave={(e) => { e.currentTarget.style.background = "#fff"; }}
                              >
                                Reject
                              </button>
                              <button
                                onClick={() => {
                                  setVersionApprovals((prev) => ({ ...prev, [activeVersion.id]: "approved" }));
                                  advanceToNext();
                                }}
                                style={{
                                  flex: 1, padding: "10px 0", borderRadius: 10,
                                  border: "1px solid #22c55e", background: "#22c55e", color: "#fff",
                                  fontSize: 13, fontWeight: 600, fontFamily: "'DM Sans', sans-serif", cursor: "pointer",
                                  transition: "background .15s",
                                }}
                                onMouseEnter={(e) => { e.currentTarget.style.background = "#16a34a"; }}
                                onMouseLeave={(e) => { e.currentTarget.style.background = "#22c55e"; }}
                              >
                                {isLast ? "Approve" : "Approve & Next \u2192"}
                              </button>
                            </>
                          )}
                        </div>
                      );
                    })()}

                    {/* Download this version */}
                    <button
                      onClick={() => downloadVersion(activeVersion)}
                      style={{
                        width: "100%", marginTop: 8, padding: "8px 0", borderRadius: 10,
                        border: "1px solid #e5e4e0", background: "#fff", color: "#666",
                        fontSize: 12, fontWeight: 500, fontFamily: "'DM Sans', sans-serif", cursor: "pointer",
                        transition: "background .15s",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "#fafaf8"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "#fff"; }}
                    >
                      {"\u2193"} Download {activeVersion.label} SVG
                    </button>

                    {/* Export all approved as ZIP */}
                    {approvedCount > 0 && (
                      <button
                        onClick={downloadAllApproved}
                        style={{
                          width: "100%", marginTop: 8, padding: "12px 0", borderRadius: 10,
                          border: "none",
                          background: allApproved ? "#22c55e" : "#e85d26",
                          color: "#fff",
                          fontSize: 14, fontWeight: 700, fontFamily: "'DM Sans', sans-serif", cursor: "pointer",
                          transition: "opacity .15s",
                          letterSpacing: ".02em",
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.9"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}
                      >
                        {allApproved
                          ? `\u2193 Download All ${versions.length} Versions as ZIP`
                          : `\u2193 Download ${approvedCount} Approved as ZIP`}
                      </button>
                    )}

                    {/* Status */}
                    {allApproved && (
                      <div style={{ marginTop: 12, fontSize: 12, color: "#22c55e", textAlign: "center", fontWeight: 500 }}>
                        All versions approved — ready for production
                      </div>
                    )}
                    {!allApproved && approvedCount === 0 && (
                      <div style={{ marginTop: 12, fontSize: 12, color: "#bbb", textAlign: "center" }}>
                        Review each version: Full Color {"\u2192"} 3-5 Color {"\u2192"} 2 Color {"\u2192"} 1 Color
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Debug: bug icon downloads JSON bundle directly — no panel needed */}

            </div>

            {/* Error fallback */}
            {error && !analysis && (
              <div style={{
                maxWidth: 820, width: "100%", margin: "16px auto",
                padding: "20px 28px", background: "#fef2f2", border: "1px solid #fecaca",
                borderRadius: 16, textAlign: "center",
              }}>
                <div style={{ fontSize: 15, color: "#dc2626", marginBottom: 8 }}>We couldn't parse this file.</div>
                <div style={{ fontSize: 13, color: "#999", marginBottom: 12 }}>{error}</div>
                <button onClick={startOver} style={{
                  padding: "8px 20px", borderRadius: 8, border: "none", background: "#e85d26",
                  color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans', sans-serif",
                }}>Try another file</button>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/* ─── Tiny reusable bits ─── */
function Label({ children }) {
  return (
    <div
      style={{
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: ".1em",
        textTransform: "uppercase",
        color: "#aaa",
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}

function ColorBtn({ color, label, onClick }) {
  return (
    <div
      onClick={onClick}
      title={label}
      style={{
        width: 36,
        height: 36,
        borderRadius: 8,
        background: color,
        border: color === "#ffffff" ? "1px solid #ddd" : "1px solid rgba(0,0,0,.12)",
        cursor: "pointer",
        transition: "transform .1s",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.transform = "scale(1.12)")}
      onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
    />
  );
}

function Tag({ label, value }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "4px 10px",
        borderRadius: 6,
        background: "#f5f4f2",
        fontSize: 12,
        color: "#666",
      }}
    >
      <span style={{ color: "#aaa", fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em" }}>
        {label}
      </span>
      {value}
    </span>
  );
}

function Btn({ children, onClick, style }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "7px 12px",
        borderRadius: 8,
        border: "1px solid #e5e4e0",
        background: "#fff",
        color: "#555",
        fontSize: 13,
        cursor: "pointer",
        fontFamily: "'DM Sans', sans-serif",
        transition: "all .12s",
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        ...style,
      }}
    >
      {children}
    </button>
  );
}

function BtnAccent({ children, onClick, style }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "8px 14px",
        borderRadius: 8,
        border: "none",
        background: "#e85d26",
        color: "#fff",
        fontSize: 13,
        fontWeight: 600,
        cursor: "pointer",
        fontFamily: "'DM Sans', sans-serif",
        transition: "all .12s",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 5,
        ...style,
      }}
    >
      {children}
    </button>
  );
}

function Swatch({ c }) {
  return (
    <span
      style={{
        width: 12,
        height: 12,
        borderRadius: 3,
        background: c,
        border: "1px solid rgba(0,0,0,.1)",
        display: "inline-block",
      }}
    />
  );
}

function Tabs({ options, active, onChange }) {
  return (
    <div
      style={{
        display: "flex",
        background: "#f5f4f2",
        borderRadius: 8,
        padding: 3,
        gap: 2,
      }}
    >
      {options.map((o, i) => (
        <button
          key={o}
          onClick={() => onChange(i)}
          style={{
            flex: 1,
            padding: "6px 12px",
            borderRadius: 6,
            fontSize: 13,
            border: "none",
            cursor: "pointer",
            fontFamily: "'DM Sans', sans-serif",
            transition: "all .12s",
            background: active === i ? "#fff" : "transparent",
            color: active === i ? "#1a1a1a" : "#999",
            boxShadow: active === i ? "0 1px 3px rgba(0,0,0,.06)" : "none",
          }}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

function Row({ children }) {
  return <div style={{ display: "flex", alignItems: "center", gap: 10 }}>{children}</div>;
}

function Mono({ children }) {
  return (
    <span
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11,
        color: "#999",
      }}
    >
      {children}
    </span>
  );
}
