// SVG version renderer: remap fills based on paint mapping

import { parseColor, rgbToLab, deltaE, isWhiteLike, rgbToHex } from "./color-utils";

const FILLABLE_TAGS = new Set(["path", "polygon", "rect", "circle", "ellipse", "polyline"]);

function getElementFillHex(el) {
  const raw = el.getAttribute("fill");
  if (!raw || raw === "none") return null;
  if (raw.startsWith("url(")) return null; // gradient ref
  const rgba = parseColor(raw);
  if (rgba.a === 0) return null;
  return rgbToHex(rgba);
}

function getGradientDominantColor(el, svgDoc) {
  const raw = el.getAttribute("fill");
  if (!raw || !raw.startsWith("url(")) return null;

  const match = raw.match(/url\(\s*#([^)]+)\s*\)/);
  if (!match) return null;

  const gradEl = svgDoc.getElementById(match[1]);
  if (!gradEl) return null;

  const stops = gradEl.querySelectorAll("stop");
  if (stops.length === 0) return null;

  // Use the first stop color as dominant
  const color = stops[0].getAttribute("stop-color") || stops[0].style?.stopColor || "#000";
  const rgba = parseColor(color);
  return rgbToHex(rgba);
}

function findNearestGroupId(hex, registries) {
  const lab = rgbToLab(parseColor(hex));
  let bestDist = Infinity;
  let bestGroupId = null;

  for (const group of registries.paintGroups) {
    const rep = group.representative;
    if (!rep || rep.type === "none") continue;

    const repLab = rep.lab || (rep.rgba ? rgbToLab(rep.rgba) : null);
    if (!repLab) continue;

    const d = deltaE(lab, repLab);
    if (d < bestDist) {
      bestDist = d;
      bestGroupId = group.id;
    }
  }

  return bestGroupId;
}

export function renderVersionSvg(svgSource, paintMapping, registries, report, includeGradients) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgSource, "image/svg+xml");
  const svg = doc.querySelector("svg");
  if (!svg) return svgSource;

  const decisions = report.decisions || [];
  const bgIds = new Set(decisions.filter((d) => d.action === "background_delete").map((d) => d.originalId));
  const counterIds = new Set(decisions.filter((d) => d.action === "counter_hole").map((d) => d.originalId));

  // Walk all fillable elements
  const walk = (el) => {
    if (FILLABLE_TAGS.has(el.tagName?.toLowerCase())) {
      const elId = el.getAttribute("id") || "";

      // Background shapes → none
      if (bgIds.has(elId)) {
        el.setAttribute("fill", "none");
        return;
      }

      // Counter holes → white
      if (counterIds.has(elId)) {
        el.setAttribute("fill", "#ffffff");
        return;
      }

      const raw = el.getAttribute("fill") || "";
      const isGradientFill = raw.startsWith("url(");

      // Determine the element's effective color
      let effectiveHex = null;
      if (isGradientFill) {
        effectiveHex = getGradientDominantColor(el, doc);
      } else {
        effectiveHex = getElementFillHex(el);
      }

      if (!effectiveHex) return;

      // Skip white-like fills
      if (isWhiteLike(parseColor(effectiveHex))) return;

      // Find which paint group this element belongs to
      const groupId = findNearestGroupId(effectiveHex, registries);
      if (!groupId) return;

      // Look up target color
      const targetHex = paintMapping.get(groupId);
      if (!targetHex || targetHex === "none") {
        el.setAttribute("fill", "none");
        return;
      }

      if (isGradientFill && includeGradients) {
        // Keep gradient as-is for full-color version
        return;
      }

      // Apply solid fill
      el.setAttribute("fill", targetHex);
    }

    if (el.children) {
      for (const child of el.children) {
        walk(child);
      }
    }
  };

  walk(svg);

  // Remove gradient defs if not including gradients
  if (!includeGradients) {
    const defs = svg.querySelector("defs");
    if (defs) {
      const grads = defs.querySelectorAll("linearGradient, radialGradient");
      for (const g of grads) {
        g.remove();
      }
      // Remove defs entirely if empty
      if (defs.children.length === 0) {
        defs.remove();
      }
    }
  }

  return new XMLSerializer().serializeToString(svg);
}
