// Build path/paint registries from normalized SVG

import { parseColor, rgbToLab, rgbToHex, clusterByPerceptualDistance } from "./color-utils";
import { geometryFingerprint, getViewBox } from "./geometry-utils";

// ─── Paint extraction ───

function resolveGradientStops(gradientEl) {
  const stops = [];
  for (const stop of gradientEl.querySelectorAll("stop")) {
    const offset = stop.getAttribute("offset") || "0%";
    const color = stop.getAttribute("stop-color") || stop.style.stopColor || "#000";
    const opacity = parseFloat(stop.getAttribute("stop-opacity") ?? stop.style.stopOpacity ?? "1");
    stops.push({ offset, color, opacity, rgb: parseColor(color) });
  }
  return stops;
}

function resolveGradientElement(svg, ref) {
  // ref looks like "url(#gradientId)"
  const match = ref.match(/url\(\s*#([^)]+)\s*\)/);
  if (!match) return null;
  const el = svg.querySelector("#" + CSS.escape(match[1]));
  if (!el) return null;
  return el;
}

export function extractPaint(el, attr, svg) {
  const raw = el.getAttribute(attr);
  if (!raw || raw === "none") {
    return { type: "none", raw: raw || "none", rgba: { r: 0, g: 0, b: 0, a: 0 } };
  }

  // Gradient reference
  if (raw.startsWith("url(")) {
    const gradEl = resolveGradientElement(svg, raw);
    if (!gradEl) {
      return { type: "complex_mesh", raw, rgba: { r: 0, g: 0, b: 0, a: 1 } };
    }
    const tag = gradEl.tagName.toLowerCase();
    const stops = resolveGradientStops(gradEl);

    if (tag === "lineargradient") {
      return {
        type: "linear",
        raw,
        gradientId: gradEl.getAttribute("id"),
        stops,
        attrs: {
          x1: gradEl.getAttribute("x1"),
          y1: gradEl.getAttribute("y1"),
          x2: gradEl.getAttribute("x2"),
          y2: gradEl.getAttribute("y2"),
          gradientUnits: gradEl.getAttribute("gradientUnits"),
          gradientTransform: gradEl.getAttribute("gradientTransform"),
        },
        rgba: stops[0]?.rgb || { r: 0, g: 0, b: 0, a: 1 },
      };
    }
    if (tag === "radialgradient") {
      return {
        type: "radial",
        raw,
        gradientId: gradEl.getAttribute("id"),
        stops,
        attrs: {
          cx: gradEl.getAttribute("cx"),
          cy: gradEl.getAttribute("cy"),
          r: gradEl.getAttribute("r"),
          fx: gradEl.getAttribute("fx"),
          fy: gradEl.getAttribute("fy"),
          gradientUnits: gradEl.getAttribute("gradientUnits"),
          gradientTransform: gradEl.getAttribute("gradientTransform"),
        },
        rgba: stops[0]?.rgb || { r: 0, g: 0, b: 0, a: 1 },
      };
    }
    return { type: "complex_mesh", raw, rgba: { r: 0, g: 0, b: 0, a: 1 } };
  }

  // Solid color
  const rgba = parseColor(raw);
  return { type: "solid", raw, rgba, lab: rgbToLab(rgba), hex: rgbToHex(rgba) };
}

// ─── Deduplication and grouping ───

function paintKey(paint) {
  if (paint.type === "none") return "none";
  if (paint.type === "solid") return `solid:${paint.hex}`;
  if (paint.type === "linear" || paint.type === "radial") {
    return `${paint.type}:${paint.stops.map((s) => s.color + "@" + s.offset).join(",")}`;
  }
  return `complex:${paint.raw}`;
}

export function deduplicatePaints(paintsList) {
  const map = new Map();
  for (const p of paintsList) {
    const k = paintKey(p);
    if (!map.has(k)) {
      map.set(k, { ...p, id: "paint_" + map.size });
    }
  }
  return map;
}

export function groupPaints(paintsMap, threshold = 12) {
  // Group solid paints by perceptual similarity
  const solids = [];
  const nonSolids = [];

  for (const [, paint] of paintsMap) {
    if (paint.type === "solid" && paint.rgba.a > 0) {
      solids.push({ id: paint.id, rgb: paint.rgba, paint });
    } else {
      nonSolids.push(paint);
    }
  }

  const clusters = clusterByPerceptualDistance(solids, threshold);
  const groups = clusters.map((cluster, i) => ({
    id: "pg_" + i,
    type: "solid_cluster",
    members: cluster.map((c) => c.id),
    representative: cluster[0].paint,
  }));

  // Add non-solid paints as individual groups
  nonSolids.forEach((p, i) => {
    groups.push({
      id: "pg_ns_" + i,
      type: p.type,
      members: [p.id],
      representative: p,
    });
  });

  return groups;
}

// ─── Main registry builder ───

export function buildRegistries(normalizedSvg) {
  const viewBox = getViewBox(normalizedSvg);
  const paths = new Map();
  const allPaints = [];
  const bindings = [];

  // Must be in DOM for geometry APIs
  const container = document.createElement("div");
  container.style.cssText = "position:absolute;left:-9999px;top:-9999px;visibility:hidden;width:600px;height:600px";
  document.body.appendChild(container);
  const svgClone = normalizedSvg.cloneNode(true);
  container.appendChild(svgClone);

  try {
    const allEls = svgClone.querySelectorAll("path");
    let zIndex = 0;

    for (const el of allEls) {
      const id = el.getAttribute("id") || el.getAttribute("data-compound-parent") || `anon_${zIndex}`;
      const pathId = `p_${zIndex}`;

      const geo = geometryFingerprint(el);
      if (geo.area === 0 && geo.perimeter === 0) {
        zIndex++;
        continue;
      }

      const fillPaint = extractPaint(el, "fill", svgClone);
      const strokePaint = extractPaint(el, "stroke", svgClone);

      allPaints.push(fillPaint);
      if (strokePaint.type !== "none") allPaints.push(strokePaint);

      const pathEntry = {
        id: pathId,
        originalId: id,
        el,
        bbox: geo.bbox,
        area: geo.area,
        centroid: geo.centroid,
        perimeter: geo.perimeter,
        pointHash: geo.pointHash,
        fillPaint,
        strokePaint,
        fillRule: el.getAttribute("fill-rule") || "nonzero",
        zIndex,
        compoundParent: el.getAttribute("data-compound-parent") || null,
        subpathIndex: el.getAttribute("data-subpath-index") != null ? parseInt(el.getAttribute("data-subpath-index")) : null,
      };

      paths.set(pathId, pathEntry);
      bindings.push({
        pathId,
        fillPaintKey: paintKey(fillPaint),
        strokePaintKey: paintKey(strokePaint),
      });

      zIndex++;
    }
  } finally {
    document.body.removeChild(container);
  }

  const paintsMap = deduplicatePaints(allPaints);
  const paintGroups = groupPaints(paintsMap);

  return { paths, paints: paintsMap, bindings, paintGroups, viewBox };
}
