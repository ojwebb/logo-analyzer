// Color parsing, Lab conversion, perceptual distance, and clustering

const NAMED_COLORS = {
  white: "#ffffff", black: "#000000", red: "#ff0000", green: "#008000",
  blue: "#0000ff", yellow: "#ffff00", cyan: "#00ffff", magenta: "#ff00ff",
  orange: "#ffa500", purple: "#800080", pink: "#ffc0cb", gray: "#808080",
  grey: "#808080", silver: "#c0c0c0", maroon: "#800000", olive: "#808000",
  lime: "#00ff00", aqua: "#00ffff", teal: "#008080", navy: "#000080",
  fuchsia: "#ff00ff", transparent: "#00000000", none: "#00000000",
};

export function parseColor(str) {
  if (!str || str === "none" || str === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  str = str.trim().toLowerCase();

  if (NAMED_COLORS[str]) str = NAMED_COLORS[str];

  // hex
  if (str.startsWith("#")) {
    let h = str.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length === 4) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
  }

  // rgb() / rgba()
  const rgbMatch = str.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/);
  if (rgbMatch) {
    let a = 1;
    if (rgbMatch[4] != null) {
      a = rgbMatch[4].endsWith("%") ? parseFloat(rgbMatch[4]) / 100 : parseFloat(rgbMatch[4]);
    }
    return { r: Math.round(+rgbMatch[1]), g: Math.round(+rgbMatch[2]), b: Math.round(+rgbMatch[3]), a };
  }

  return { r: 0, g: 0, b: 0, a: 1 };
}

// sRGB → CIE Lab via XYZ
export function rgbToLab({ r, g, b }) {
  // Linearize sRGB
  let rr = r / 255, gg = g / 255, bb = b / 255;
  rr = rr > 0.04045 ? Math.pow((rr + 0.055) / 1.055, 2.4) : rr / 12.92;
  gg = gg > 0.04045 ? Math.pow((gg + 0.055) / 1.055, 2.4) : gg / 12.92;
  bb = bb > 0.04045 ? Math.pow((bb + 0.055) / 1.055, 2.4) : bb / 12.92;

  // sRGB → XYZ (D65)
  let x = (rr * 0.4124564 + gg * 0.3575761 + bb * 0.1804375) / 0.95047;
  let y = rr * 0.2126729 + gg * 0.7151522 + bb * 0.0721750;
  let z = (rr * 0.0193339 + gg * 0.1191920 + bb * 0.9503041) / 1.08883;

  const f = (t) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  x = f(x); y = f(y); z = f(z);

  return { L: 116 * y - 16, a: 500 * (x - y), b: 200 * (y - z) };
}

// CIE76 ΔE
export function deltaE(lab1, lab2) {
  return Math.sqrt(
    (lab1.L - lab2.L) ** 2 +
    (lab1.a - lab2.a) ** 2 +
    (lab1.b - lab2.b) ** 2
  );
}

export function isWhiteLike(rgb) {
  const lab = rgbToLab(rgb);
  const chroma = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
  return lab.L > 92 && chroma < 8;
}

export function rgbToHex({ r, g, b }) {
  return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}

// Single-linkage agglomerative clustering by perceptual distance
export function clusterByPerceptualDistance(items, threshold = 12) {
  if (items.length === 0) return [];
  const labs = items.map((it) => ({ item: it, lab: rgbToLab(it.rgb) }));
  const clusters = labs.map((l, i) => ({ id: i, members: [l] }));
  const active = new Set(clusters.map((c) => c.id));

  while (active.size > 1) {
    let bestDist = Infinity, bestA = -1, bestB = -1;
    const ids = [...active];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const ca = clusters[ids[i]], cb = clusters[ids[j]];
        for (const ma of ca.members) {
          for (const mb of cb.members) {
            const d = deltaE(ma.lab, mb.lab);
            if (d < bestDist) { bestDist = d; bestA = ids[i]; bestB = ids[j]; }
          }
        }
      }
    }
    if (bestDist > threshold) break;
    clusters[bestA].members.push(...clusters[bestB].members);
    active.delete(bestB);
  }

  return [...active].map((id) => clusters[id].members.map((m) => m.item));
}
