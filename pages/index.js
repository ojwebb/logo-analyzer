import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import Head from "next/head";

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

/* ────────────────────── TETRIS ────────────────────── */
const COLS = 10, ROWS = 20, SZ = 22;
const TETROS = [
  { shape: [[1,1,1,1]], color: "#00b4d8" },
  { shape: [[1,1],[1,1]], color: "#e9c46a" },
  { shape: [[0,1,0],[1,1,1]], color: "#9b5de5" },
  { shape: [[1,0,0],[1,1,1]], color: "#e85d26" },
  { shape: [[0,0,1],[1,1,1]], color: "#3b82f6" },
  { shape: [[0,1,1],[1,1,0]], color: "#06d6a0" },
  { shape: [[1,1,0],[0,1,1]], color: "#ef476f" },
];

function Tetris() {
  const canvasRef = useRef(null);
  const state = useRef(null);
  const raf = useRef(null);
  const lastDrop = useRef(0);
  const keys = useRef({});
  const lastMove = useRef(0);
  const [score, setScore] = useState(0);
  const [gameOver, setGameOver] = useState(false);

  const init = useCallback(() => {
    const grid = Array.from({ length: ROWS }, () => Array(COLS).fill(0));
    const colors = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
    state.current = { grid, colors, piece: null, px: 0, py: 0, speed: 500 };
    setScore(0);
    setGameOver(false);
    lastDrop.current = 0;
    spawn();
  }, []);

  function spawn() {
    const s = state.current;
    const t = TETROS[Math.floor(Math.random() * TETROS.length)];
    s.piece = { shape: t.shape.map(r => [...r]), color: t.color };
    s.px = Math.floor((COLS - t.shape[0].length) / 2);
    s.py = 0;
    if (collides(s.grid, s.piece.shape, s.px, s.py)) {
      setGameOver(true);
    }
  }

  function collides(grid, shape, px, py) {
    for (let r = 0; r < shape.length; r++)
      for (let c = 0; c < shape[r].length; c++)
        if (shape[r][c]) {
          const nx = px + c, ny = py + r;
          if (nx < 0 || nx >= COLS || ny >= ROWS) return true;
          if (ny >= 0 && grid[ny][nx]) return true;
        }
    return false;
  }

  function lock() {
    const s = state.current;
    const { shape, color } = s.piece;
    for (let r = 0; r < shape.length; r++)
      for (let c = 0; c < shape[r].length; c++)
        if (shape[r][c]) {
          const ny = s.py + r, nx = s.px + c;
          if (ny >= 0 && ny < ROWS && nx >= 0 && nx < COLS) {
            s.grid[ny][nx] = 1;
            s.colors[ny][nx] = color;
          }
        }
    let cleared = 0;
    for (let r = ROWS - 1; r >= 0; r--) {
      if (s.grid[r].every(v => v)) {
        s.grid.splice(r, 1);
        s.colors.splice(r, 1);
        s.grid.unshift(Array(COLS).fill(0));
        s.colors.unshift(Array(COLS).fill(null));
        cleared++;
        r++;
      }
    }
    if (cleared) {
      const pts = [0, 100, 300, 500, 800][cleared] || 800;
      setScore(p => p + pts);
      s.speed = Math.max(100, s.speed - cleared * 15);
    }
    spawn();
  }

  function rotate(shape) {
    const rows = shape.length, cols = shape[0].length;
    const r = Array.from({ length: cols }, () => Array(rows).fill(0));
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++)
        r[x][rows - 1 - y] = shape[y][x];
    return r;
  }

  function draw() {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext("2d");
    const s = state.current;
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(0, 0, cvs.width, cvs.height);
    // grid lines
    ctx.strokeStyle = "#2a2a2a";
    ctx.lineWidth = 0.5;
    for (let r = 0; r <= ROWS; r++) {
      ctx.beginPath(); ctx.moveTo(0, r * SZ); ctx.lineTo(COLS * SZ, r * SZ); ctx.stroke();
    }
    for (let c = 0; c <= COLS; c++) {
      ctx.beginPath(); ctx.moveTo(c * SZ, 0); ctx.lineTo(c * SZ, ROWS * SZ); ctx.stroke();
    }
    // locked blocks
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++)
        if (s.grid[r][c]) {
          ctx.fillStyle = s.colors[r][c] || "#888";
          ctx.fillRect(c * SZ + 1, r * SZ + 1, SZ - 2, SZ - 2);
          ctx.fillStyle = "rgba(255,255,255,0.15)";
          ctx.fillRect(c * SZ + 1, r * SZ + 1, SZ - 2, 2);
        }
    // current piece
    if (s.piece) {
      const { shape, color } = s.piece;
      // ghost
      let gy = s.py;
      while (!collides(s.grid, shape, s.px, gy + 1)) gy++;
      ctx.fillStyle = color + "30";
      for (let r = 0; r < shape.length; r++)
        for (let c = 0; c < shape[r].length; c++)
          if (shape[r][c])
            ctx.fillRect((s.px + c) * SZ + 1, (gy + r) * SZ + 1, SZ - 2, SZ - 2);
      // actual
      ctx.fillStyle = color;
      for (let r = 0; r < shape.length; r++)
        for (let c = 0; c < shape[r].length; c++)
          if (shape[r][c]) {
            ctx.fillRect((s.px + c) * SZ + 1, (s.py + r) * SZ + 1, SZ - 2, SZ - 2);
            ctx.fillStyle = "rgba(255,255,255,0.2)";
            ctx.fillRect((s.px + c) * SZ + 1, (s.py + r) * SZ + 1, SZ - 2, 2);
            ctx.fillStyle = color;
          }
    }
  }

  useEffect(() => {
    init();
    const onKey = (e) => {
      if (["ArrowLeft","ArrowRight","ArrowDown","ArrowUp"," "].includes(e.key)) e.preventDefault();
      keys.current[e.key] = true;
    };
    const onKeyUp = (e) => { keys.current[e.key] = false; };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [init]);

  useEffect(() => {
    if (gameOver) return;
    const loop = (ts) => {
      const s = state.current;
      if (!s || !s.piece) { raf.current = requestAnimationFrame(loop); return; }
      const now = ts || 0;
      // input
      if (now - lastMove.current > 80) {
        if (keys.current["ArrowLeft"] && !collides(s.grid, s.piece.shape, s.px - 1, s.py)) s.px--;
        if (keys.current["ArrowRight"] && !collides(s.grid, s.piece.shape, s.px + 1, s.py)) s.px++;
        if (keys.current["ArrowDown"] && !collides(s.grid, s.piece.shape, s.px, s.py + 1)) { s.py++; lastDrop.current = now; }
        if (keys.current["ArrowUp"] || keys.current[" "]) {
          const rot = rotate(s.piece.shape);
          if (!collides(s.grid, rot, s.px, s.py)) s.piece.shape = rot;
          else if (!collides(s.grid, rot, s.px - 1, s.py)) { s.piece.shape = rot; s.px--; }
          else if (!collides(s.grid, rot, s.px + 1, s.py)) { s.piece.shape = rot; s.px++; }
          keys.current["ArrowUp"] = false;
          keys.current[" "] = false;
        }
        lastMove.current = now;
      }
      // gravity
      if (now - lastDrop.current > s.speed) {
        if (!collides(s.grid, s.piece.shape, s.px, s.py + 1)) s.py++;
        else lock();
        lastDrop.current = now;
      }
      draw();
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, [gameOver]);

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "#999" }}>
          Score: {score}
        </span>
        {gameOver && (
          <button onClick={init} style={{
            padding: "4px 12px", borderRadius: 6, border: "1px solid #e5e4e0",
            background: "#fff", color: "#e85d26", fontSize: 12, cursor: "pointer",
            fontFamily: "'DM Sans', sans-serif", fontWeight: 600,
          }}>
            Restart
          </button>
        )}
      </div>
      <canvas
        ref={canvasRef}
        width={COLS * SZ}
        height={ROWS * SZ}
        style={{ borderRadius: 10, border: "1px solid #333" }}
      />
      {gameOver && (
        <div style={{ fontSize: 13, color: "#e85d26", fontWeight: 600 }}>Game Over!</div>
      )}
      <div style={{ fontSize: 11, color: "#aaa", textAlign: "center", lineHeight: 1.5 }}>
        Arrow keys to move &middot; Up/Space to rotate
      </div>
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

  const svgRef = useRef(null);
  const fileRef = useRef(null);

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

  /* ─── Full pipeline: upload → vectorize (if raster) → analyze ─── */
  const processFile = useCallback(
    async (file) => {
      setError("");
      setAnalysis(null);
      setSvgSource("");
      setLogs([]);
      logStartRef.current = Date.now();

      const isSvg = file.type === "image/svg+xml" || file.name.endsWith(".svg");
      const sizeMB = (file.size / 1024 / 1024).toFixed(2);

      // Show preview
      setPreview(URL.createObjectURL(file));
      setStep("uploading");
      setElapsed(0);
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = setInterval(() => setElapsed((p) => p + 1), 1000);

      addLog(`File selected: ${file.name} (${sizeMB} MB, ${file.type || "unknown type"})`);

      let svgText;

      if (isSvg) {
        addLog("SVG detected — skipping vectorization");
        svgText = await file.text();
        addLog(`SVG loaded (${(svgText.length / 1024).toFixed(1)} KB)`);
      } else {
        // Vectorize raster
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
          addLog(`Vectorization complete (${(svgText.length / 1024).toFixed(1)} KB SVG)`);
        } catch (e) {
          if (timerRef.current) clearInterval(timerRef.current);
          const msg = e.name === "AbortError" ? "Vectorization timed out (65s). Try a smaller image." : e.message;
          addLog(`ERROR: ${msg}`);
          setError(msg);
          setStep("idle");
          return;
        }
      }

      addLog("Mounting SVG into editor…");
      mountSvg(svgText);
      setStep("analyzing");
      addLog("SVG mounted — discovering shapes…");
    },
    [mountSvg, addLog]
  );

  /* ─── Discover shapes on SVG mount ─── */
  useEffect(() => {
    if (!svgSource || !svgRef.current) return;
    const c = svgRef.current;
    c.innerHTML = svgSource;
    const svg = c.querySelector("svg");
    if (!svg) return;
    svg.style.width = "100%";
    svg.style.height = "100%";
    svg.style.maxHeight = "460px";
    if (!svg.querySelector("defs")) {
      svg.prepend(document.createElementNS("http://www.w3.org/2000/svg", "defs"));
    }
    const found = [];
    let i = 0;
    const walk = (el) => {
      if (FILLABLE.has(el.tagName?.toLowerCase())) {
        const f = el.getAttribute("fill");
        if (f === "none") return;
        if (!el.id) el.id = "s" + i;
        found.push({ id: el.id, tag: el.tagName, fill: f || "#000" });
        i++;
      }
      if (el.children) [...el.children].forEach(walk);
    };
    walk(svg);
    setShapes(found);
    setSel(new Set());
    addLog(`Found ${found.length} editable shapes`);
  }, [svgSource, addLog]);

  /* ─── Run analysis after shapes discovered ─── */
  useEffect(() => {
    if (step !== "analyzing" || shapes.length === 0) return;

    const run = async () => {
      try {
        const svg = svgRef.current?.querySelector("svg");
        if (!svg) throw new Error("No SVG element");
        addLog("Rendering SVG to PNG for analysis…");
        const pngB64 = await svgToPngBase64(svg);
        addLog(`PNG rendered (${(pngB64.length * 0.75 / 1024).toFixed(1)} KB)`);
        const shapeData = shapes
          .map((s, i) => `Shape ${i + 1}: id="${s.id}", tag=<${s.tag}>, fill="${s.fill}"`)
          .join("\n");

        addLog("Sending to GPT-5.2 Vision for analysis…");
        const ac = new AbortController();
        const at = setTimeout(() => ac.abort(), 65000);
        const resp = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ imageBase64: pngB64, shapeData }),
          signal: ac.signal,
        });
        clearTimeout(at);
        addLog(`Analysis API responded: HTTP ${resp.status}`);
        if (!resp.ok) throw new Error("Analysis failed (" + resp.status + ")");
        const data = await resp.json();
        setAnalysis(data);
        addLog(`Analysis complete — ${data.colors?.length || 0} colors, mood: ${data.mood || "n/a"}`);

        if (data.gradientSuggestion?.recommended) {
          const gs = data.gradientSuggestion;
          setGStart(gs.startColor || "#3b82f6");
          setGEnd(gs.endColor || "#8b5cf6");
          setGType(gs.type || "linear");
          setGAngle(gs.angle || 135);
          addLog("Gradient suggestion loaded");
        }
        if (timerRef.current) clearInterval(timerRef.current);
        addLog("Done!");
        setStep("ready");
      } catch (e) {
        if (timerRef.current) clearInterval(timerRef.current);
        const msg = e.name === "AbortError" ? "Analysis timed out (65s). Try again." : e.message;
        addLog(`ERROR: ${msg}`);
        setError(msg);
        setStep("ready");
      }
    };
    run();
  }, [step, shapes]);

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
      return n;
    });
  }, []);

  useEffect(() => {
    const svg = svgRef.current?.querySelector("svg");
    if (!svg) return;
    shapes.forEach((s) => {
      const el = svg.getElementById(s.id);
      if (!el) return;
      el.style.cursor = "pointer";
      el.classList.toggle("sel", sel.has(s.id));
      el.onclick = (e) => handleShapeClick(e, s.id);
    });
  }, [shapes, sel, handleShapeClick]);

  /* ─── Fill operations ─── */
  const getCur = () => svgRef.current?.querySelector("svg")?.outerHTML || "";

  const targets = () => {
    const svg = svgRef.current?.querySelector("svg");
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
    const svg = svgRef.current?.querySelector("svg");
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
    const svg = svgRef.current?.querySelector("svg");
    if (!svg) return null;
    const cl = svg.cloneNode(true);
    cl.querySelectorAll(".sel").forEach((e) => e.classList.remove("sel"));
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
    vectorizing: "Vectorizing with AI…",
    analyzing: "Analyzing brand identity…",
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
        *,
        *::before,
        *::after {
          box-sizing: border-box;
          margin: 0;
        }
        html {
          background: #faf9f7;
          color: #1a1a1a;
        }
        body {
          font-family: "Bouba Round", "DM Sans", sans-serif;
          -webkit-font-smoothing: antialiased;
        }
        .sel {
          stroke: #e85d26 !important;
          stroke-width: 2px !important;
          stroke-dasharray: 6 3 !important;
          filter: drop-shadow(0 0 6px rgba(232, 93, 38, 0.35)) !important;
        }
        .checker {
          background-color: #f5f4f2;
          background-image: linear-gradient(
              45deg,
              #eeede9 25%,
              transparent 25%
            ),
            linear-gradient(-45deg, #eeede9 25%, transparent 25%),
            linear-gradient(45deg, transparent 75%, #eeede9 75%),
            linear-gradient(-45deg, transparent 75%, #eeede9 75%);
          background-size: 14px 14px;
          background-position: 0 0, 0 7px, 7px -7px, -7px 0;
        }
        input[type="color"] {
          -webkit-appearance: none;
          border: 1px solid #ddd;
          width: 36px;
          height: 36px;
          border-radius: 8px;
          cursor: pointer;
          padding: 0;
          overflow: hidden;
          background: transparent;
        }
        input[type="color"]::-webkit-color-swatch-wrapper {
          padding: 0;
        }
        input[type="color"]::-webkit-color-swatch {
          border: none;
          border-radius: 7px;
        }
        input[type="range"] {
          -webkit-appearance: none;
          background: #e5e4e0;
          height: 3px;
          border-radius: 2px;
          outline: none;
          width: 100%;
        }
        input[type="range"]::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: #e85d26;
          cursor: pointer;
        }
        @keyframes spin {
          to {
            transform: rotate(360deg);
          }
        }
        @keyframes fadeUp {
          from {
            opacity: 0;
            transform: translateY(12px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .fade-up {
          animation: fadeUp 0.5s ease both;
        }
      `}</style>

      <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
        {/* Header — minimal */}
        <header
          style={{
            padding: "16px 28px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottom: "1px solid #eeede9",
          }}
        >
          <div
            style={{ display: "flex", alignItems: "center", cursor: "pointer" }}
            onClick={startOver}
          >
            <img
              src="/logo.svg"
              alt="Merch.ai"
              style={{ height: 28 }}
            />
          </div>
          {isReady && (
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-ghost" onClick={undo} disabled={hIdx <= 0}>
                Undo
              </button>
              <button
                className="btn btn-ghost"
                onClick={redo}
                disabled={hIdx >= history.length - 1}
              >
                Redo
              </button>
              <button className="btn btn-ghost" onClick={startOver}>
                New Logo
              </button>
            </div>
          )}
        </header>

        {/* ─── IDLE: Upload ─── */}
        {step === "idle" && (
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 32,
            }}
          >
            <div className="fade-up" style={{ maxWidth: 480, width: "100%", textAlign: "center" }}>
              <h1
                style={{
                  fontFamily: "'Bouba Round', sans-serif",
                  fontSize: 44,
                  fontWeight: 400,
                  lineHeight: 1.1,
                  marginBottom: 36,
                  color: "#1a1a1a",
                }}
              >
                Upload your logo
              </h1>

              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileRef.current?.click()}
                style={{
                  border: `2px dashed ${dragOver ? "#e85d26" : "#d5d4d0"}`,
                  borderRadius: 20,
                  padding: "56px 32px",
                  cursor: "pointer",
                  transition: "all .2s",
                  background: dragOver ? "rgba(232,93,38,.03)" : "#fff",
                }}
              >
                <div style={{ fontSize: 36, marginBottom: 8, opacity: 0.2 }}>↑</div>
                <div style={{ fontSize: 15, color: "#666", marginBottom: 4 }}>
                  Drag & drop or <span style={{ color: "#e85d26", fontWeight: 500 }}>browse</span>
                </div>
                <div style={{ fontSize: 13, color: "#aaa" }}>PNG, JPG, SVG — max 10MB</div>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/*,.svg"
                style={{ display: "none" }}
                onChange={(e) => handleFile(e.target.files[0])}
              />
              {error && (
                <div
                  style={{
                    marginTop: 16,
                    padding: "10px 16px",
                    background: "#fef2f2",
                    border: "1px solid #fecaca",
                    borderRadius: 10,
                    fontSize: 13,
                    color: "#dc2626",
                  }}
                >
                  {error}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ─── PROCESSING: Tetris + Log ─── */}
        {isProcessing && (
          <div
            className="fade-up"
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
            }}
          >
            <div
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 40,
                padding: "24px 32px 12px",
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
                {preview && (
                  <div
                    style={{
                      width: 80,
                      height: 80,
                      borderRadius: 12,
                      overflow: "hidden",
                      border: "1px solid #eee",
                    }}
                  >
                    <img
                      src={preview}
                      alt=""
                      style={{ width: "100%", height: "100%", objectFit: "contain" }}
                    />
                  </div>
                )}
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div
                    style={{
                      width: 20,
                      height: 20,
                      border: "2.5px solid #eee",
                      borderTopColor: "#e85d26",
                      borderRadius: "50%",
                      animation: "spin .6s linear infinite",
                    }}
                  />
                  <div style={{ fontSize: 14, color: "#888" }}>{statusMsg[step]}</div>
                </div>
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "#bbb" }}>
                  {elapsed}s elapsed
                </div>
                <div style={{ fontSize: 12, color: "#bbb", marginTop: 2 }}>
                  Play while you wait!
                </div>
              </div>
              <Tetris />
            </div>
            {/* Log panel */}
            <div
              style={{
                borderTop: "1px solid #eeede9",
                background: "#1a1a1a",
                padding: "10px 16px",
                maxHeight: 180,
                overflowY: "auto",
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
                lineHeight: 1.7,
              }}
              ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }}
            >
              {logs.map((l, i) => (
                <div key={i}>
                  <span style={{ color: "#666" }}>[{l.t}s]</span>{" "}
                  <span style={{ color: l.msg.startsWith("ERROR") ? "#ef476f" : l.msg === "Done!" ? "#06d6a0" : "#aaa" }}>
                    {l.msg}
                  </span>
                </div>
              ))}
              <div style={{ color: "#555" }}>
                <span style={{ animation: "spin .6s linear infinite", display: "inline-block" }}>⠋</span> waiting…
              </div>
            </div>
          </div>
        )}

        {/* ─── READY: Analysis + Editor ─── */}
        {isReady && (
          <div
            className="fade-up"
            style={{
              flex: 1,
              display: "flex",
              minHeight: 0,
            }}
          >
            {/* Canvas */}
            <div
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                padding: 32,
              }}
            >
              <div
                className="checker"
                style={{
                  borderRadius: 20,
                  border: "1px solid #eeede9",
                  padding: 40,
                  width: "100%",
                  maxWidth: 560,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  minHeight: 360,
                }}
              >
                <div
                  ref={svgRef}
                  style={{ width: "100%", display: "flex", justifyContent: "center" }}
                />
              </div>

              {/* Analysis description */}
              {analysis?.description && (
                <div
                  style={{
                    maxWidth: 560,
                    width: "100%",
                    marginTop: 20,
                    padding: "16px 20px",
                    background: "#fff",
                    border: "1px solid #eeede9",
                    borderRadius: 14,
                  }}
                >
                  <p
                    style={{
                      fontSize: 15,
                      lineHeight: 1.6,
                      color: "#444",
                      margin: 0,
                    }}
                  >
                    {analysis.description}
                  </p>
                  {analysis.colors?.length > 0 && (
                    <div
                      style={{
                        display: "flex",
                        gap: 8,
                        marginTop: 12,
                        flexWrap: "wrap",
                        alignItems: "center",
                      }}
                    >
                      {analysis.colors.map((c, i) => (
                        <div key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          <div
                            style={{
                              width: 16,
                              height: 16,
                              borderRadius: 4,
                              background: c,
                              border: "1px solid rgba(0,0,0,.1)",
                            }}
                          />
                          <span
                            style={{
                              fontFamily: "'JetBrains Mono', monospace",
                              fontSize: 11,
                              color: "#999",
                            }}
                          >
                            {c}
                          </span>
                        </div>
                      ))}
                      {analysis.mood && (
                        <span
                          style={{
                            fontSize: 12,
                            color: "#e85d26",
                            fontWeight: 500,
                            marginLeft: 4,
                          }}
                        >
                          {analysis.mood}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Right panel: Edit controls */}
            <aside
              style={{
                width: 300,
                minWidth: 300,
                borderLeft: "1px solid #eeede9",
                background: "#fff",
                overflowY: "auto",
                padding: 20,
                display: "flex",
                flexDirection: "column",
                gap: 20,
              }}
            >
              {/* Selection */}
              <div>
                <Label>Shapes · {shapes.length}</Label>
                <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                  <Btn onClick={() => setSel(new Set(shapes.map((s) => s.id)))}>
                    Select All
                  </Btn>
                  <Btn onClick={() => setSel(new Set())}>Clear</Btn>
                </div>
                <div style={{ fontSize: 12, color: "#999" }}>
                  Editing{" "}
                  <span style={{ color: "#e85d26", fontWeight: 500 }}>{tgtLabel}</span>
                </div>
              </div>

              {/* Quick fills */}
              <div>
                <Label>Quick Fill</Label>
                <div style={{ display: "flex", gap: 6 }}>
                  <Btn onClick={() => applySolid("#ffffff")}>
                    <Swatch c="#fff" /> White
                  </Btn>
                  <Btn onClick={() => applySolid("#000000")}>
                    <Swatch c="#000" /> Black
                  </Btn>
                </div>
              </div>

              {/* Mode */}
              <div>
                <Label>Fill Mode</Label>
                <Tabs
                  options={["Solid", "Gradient"]}
                  active={mode === "solid" ? 0 : 1}
                  onChange={(i) => setMode(i === 0 ? "solid" : "gradient")}
                />
              </div>

              {mode === "solid" && (
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <input
                    type="color"
                    value={solidClr}
                    onChange={(e) => setSolidClr(e.target.value)}
                  />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13 }}>Color</div>
                    <Mono>{solidClr}</Mono>
                  </div>
                  <BtnAccent onClick={() => applyFill(solidClr)}>Apply</BtnAccent>
                </div>
              )}

              {mode === "gradient" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <Tabs
                    options={["Linear", "Radial"]}
                    active={gType === "linear" ? 0 : 1}
                    onChange={(i) => setGType(i === 0 ? "linear" : "radial")}
                  />
                  <div
                    style={{
                      height: 24,
                      borderRadius: 6,
                      border: "1px solid #eee",
                      background:
                        gType === "linear"
                          ? `linear-gradient(${gAngle}deg, ${gStart}, ${gEnd})`
                          : `radial-gradient(circle, ${gStart}, ${gEnd})`,
                    }}
                  />
                  <Row>
                    <input
                      type="color"
                      value={gStart}
                      onChange={(e) => setGStart(e.target.value)}
                    />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12 }}>Start</div>
                      <Mono>{gStart}</Mono>
                    </div>
                  </Row>
                  <Row>
                    <input
                      type="color"
                      value={gEnd}
                      onChange={(e) => setGEnd(e.target.value)}
                    />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12 }}>End</div>
                      <Mono>{gEnd}</Mono>
                    </div>
                  </Row>
                  <Btn
                    onClick={() => {
                      const t = gStart;
                      setGStart(gEnd);
                      setGEnd(t);
                    }}
                  >
                    ⇄ Swap
                  </Btn>
                  {gType === "linear" && (
                    <div>
                      <div style={{ fontSize: 12, color: "#999", marginBottom: 4 }}>
                        Angle <Mono>{gAngle}°</Mono>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={360}
                        value={gAngle}
                        onChange={(e) => setGAngle(+e.target.value)}
                      />
                    </div>
                  )}
                  <BtnAccent onClick={applyGrad}>Apply Gradient</BtnAccent>
                </div>
              )}

              {/* AI suggestion */}
              {analysis?.gradientSuggestion?.recommended && (
                <div>
                  <Label>AI Suggestion</Label>
                  <div
                    style={{
                      padding: 12,
                      background: "#faf9f7",
                      borderRadius: 10,
                      border: "1px solid #eeede9",
                    }}
                  >
                    <div
                      style={{
                        height: 24,
                        borderRadius: 6,
                        marginBottom: 8,
                        border: "1px solid #eee",
                        background:
                          analysis.gradientSuggestion.type === "linear"
                            ? `linear-gradient(${analysis.gradientSuggestion.angle || 135}deg, ${analysis.gradientSuggestion.startColor}, ${analysis.gradientSuggestion.endColor})`
                            : `radial-gradient(circle, ${analysis.gradientSuggestion.startColor}, ${analysis.gradientSuggestion.endColor})`,
                      }}
                    />
                    <p style={{ fontSize: 12, color: "#888", lineHeight: 1.5, margin: "0 0 10px" }}>
                      {analysis.gradientSuggestion.reason}
                    </p>
                    <BtnAccent
                      onClick={() => {
                        const gs = analysis.gradientSuggestion;
                        setGStart(gs.startColor);
                        setGEnd(gs.endColor);
                        setGType(gs.type || "linear");
                        setGAngle(gs.angle || 135);
                        setMode("gradient");
                        setTimeout(applyGrad, 50);
                      }}
                    >
                      Apply Suggestion
                    </BtnAccent>
                  </div>
                </div>
              )}

              {/* Export */}
              <div>
                <Label>Export</Label>
                <div style={{ display: "flex", gap: 6 }}>
                  <BtnAccent onClick={download} style={{ flex: 1 }}>
                    ↓ Download SVG
                  </BtnAccent>
                  <Btn onClick={copySvg}>{copied ? "✓" : "Copy"}</Btn>
                </div>
              </div>
            </aside>
          </div>
        )}
      </div>

      {/* Shared component styles */}
      <style jsx>{`
        .btn {
          padding: 7px 12px;
          border-radius: 8px;
          border: 1px solid #e5e4e0;
          background: #fff;
          color: #555;
          font-size: 13px;
          cursor: pointer;
          font-family: "DM Sans", sans-serif;
          transition: all 0.12s;
          display: inline-flex;
          align-items: center;
          gap: 5px;
        }
        .btn:hover {
          background: #f5f4f2;
          border-color: #ddd;
        }
        .btn:disabled {
          opacity: 0.35;
          pointer-events: none;
        }
        .btn-ghost {
          background: transparent;
          border-color: transparent;
          color: #888;
          font-size: 13px;
        }
        .btn-ghost:hover {
          color: #555;
          background: #f5f4f2;
        }
      `}</style>
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
