// Version engine: ink profiling, version recommendation, palette extraction, paint mapping

import { isWhiteLike, rgbToLab, deltaE, rgbToHex } from "./color-utils";
import { renderVersionSvg } from "./svg-version-renderer";

// ─── Ink profiling ───

export function computeInkProfile(registries, report) {
  const { paths, paints, paintGroups } = registries;
  const decisions = report.decisions || [];

  // Build set of pathIds classified as background/counter
  const excludedPathIds = new Set();
  for (const d of decisions) {
    if (d.action === "background_delete" || d.action === "counter_hole") {
      excludedPathIds.add(d.pathId);
    }
  }

  // Check if a paint group's members are ALL excluded paths
  function isGroupExcluded(group) {
    // Find which paths use paints in this group
    for (const memberId of group.members) {
      // Find paths that use this paint
      for (const [, path] of paths) {
        if (path.fillPaint?.id === memberId && !excludedPathIds.has(path.id)) {
          return false; // At least one path using this paint is NOT excluded
        }
      }
    }
    return true;
  }

  // Compute area per paint group
  function groupArea(group) {
    let total = 0;
    for (const memberId of group.members) {
      for (const [, path] of paths) {
        if (path.fillPaint?.id === memberId && !excludedPathIds.has(path.id)) {
          total += path.area;
        }
      }
    }
    return total;
  }

  const inkColors = [];
  let gradientPresent = false;

  for (const group of paintGroups) {
    const rep = group.representative;
    if (!rep) continue;

    // Skip none
    if (rep.type === "none") continue;

    // Skip white-like solids
    if (rep.type === "solid" && rep.rgba && isWhiteLike(rep.rgba)) continue;

    // Skip if all paths in this group are excluded
    if (isGroupExcluded(group)) continue;

    // Check for gradients
    if (rep.type === "linear" || rep.type === "radial") {
      gradientPresent = true;
    }

    inkColors.push({
      groupId: group.id,
      paint: rep,
      hex: rep.hex || (rep.rgba ? rgbToHex(rep.rgba) : "#000000"),
      lab: rep.lab || (rep.rgba ? rgbToLab(rep.rgba) : { L: 0, a: 0, b: 0 }),
      area: groupArea(group),
      isGradient: rep.type === "linear" || rep.type === "radial",
      stops: rep.stops || null,
    });
  }

  // Sort by area (largest first)
  inkColors.sort((a, b) => b.area - a.area);

  return {
    inkColors,
    gradientPresent,
    inkCount: inkColors.length,
  };
}

// ─── Version recommendation ───

const VERSION_SPECS = {
  v_full: { id: "v_full", label: "Full Color", maxColors: Infinity, includeGradients: true },
  v_3to5: { id: "v_3to5", label: "3-5 Color", maxColors: 5, includeGradients: false },
  v_2: { id: "v_2", label: "2 Color", maxColors: 2, includeGradients: false },
  v_1: { id: "v_1", label: "1 Color", maxColors: 1, includeGradients: false },
};

export function recommendVersions(/* inkProfile */) {
  // Always generate all 4 versions — full color, quantized 3-5, 2-color, 1-color
  return [VERSION_SPECS.v_full, VERSION_SPECS.v_3to5, VERSION_SPECS.v_2, VERSION_SPECS.v_1];
}

// ─── Palette extraction (greedy deltaE merge) ───

export function extractPalette(inkProfile, maxColors) {
  const { inkColors } = inkProfile;
  if (inkColors.length === 0) return [];
  if (inkColors.length <= maxColors) {
    return inkColors.map((c) => ({ hex: c.hex, lab: c.lab, area: c.area }));
  }

  // Clone for merging
  let palette = inkColors.map((c) => ({
    hex: c.hex,
    lab: { ...c.lab },
    area: c.area,
    rgb: c.paint?.rgba || { r: 0, g: 0, b: 0, a: 1 },
  }));

  while (palette.length > maxColors) {
    // Find closest pair
    let minDist = Infinity;
    let mergeA = 0;
    let mergeB = 1;

    for (let i = 0; i < palette.length; i++) {
      for (let j = i + 1; j < palette.length; j++) {
        const d = deltaE(palette[i].lab, palette[j].lab);
        if (d < minDist) {
          minDist = d;
          mergeA = i;
          mergeB = j;
        }
      }
    }

    // Area-weighted merge
    const a = palette[mergeA];
    const b = palette[mergeB];
    const totalArea = a.area + b.area;
    const wA = totalArea > 0 ? a.area / totalArea : 0.5;
    const wB = 1 - wA;

    const mergedRgb = {
      r: Math.round(a.rgb.r * wA + b.rgb.r * wB),
      g: Math.round(a.rgb.g * wA + b.rgb.g * wB),
      b: Math.round(a.rgb.b * wA + b.rgb.b * wB),
      a: 1,
    };

    a.rgb = mergedRgb;
    a.hex = rgbToHex(mergedRgb);
    a.lab = rgbToLab(mergedRgb);
    a.area = totalArea;

    palette.splice(mergeB, 1);
  }

  return palette.map((p) => ({ hex: p.hex, lab: p.lab, area: p.area }));
}

// ─── Paint mapping ───

export function buildPaintMapping(inkProfile, palette, registries, report) {
  const mapping = new Map(); // groupId → targetHex
  const decisions = report.decisions || [];

  // Build excluded set
  const excludedPathIds = new Set();
  for (const d of decisions) {
    if (d.action === "background_delete" || d.action === "counter_hole") {
      excludedPathIds.add(d.pathId);
    }
  }

  for (const group of registries.paintGroups) {
    const rep = group.representative;
    if (!rep) continue;

    if (rep.type === "none") {
      mapping.set(group.id, "none");
      continue;
    }

    // White-like → keep as white
    if (rep.type === "solid" && rep.rgba && isWhiteLike(rep.rgba)) {
      mapping.set(group.id, "#ffffff");
      continue;
    }

    // Find nearest palette color
    const repLab = rep.lab || (rep.rgba ? rgbToLab(rep.rgba) : { L: 0, a: 0, b: 0 });
    let bestDist = Infinity;
    let bestHex = palette[0]?.hex || "#000000";

    for (const p of palette) {
      const d = deltaE(repLab, p.lab);
      if (d < bestDist) {
        bestDist = d;
        bestHex = p.hex;
      }
    }

    mapping.set(group.id, bestHex);
  }

  return mapping;
}

// ─── Orchestrator ───

export function generateAllVersions(registries, report, svgSource) {
  if (!registries || !report || !svgSource) return [];

  const inkProfile = computeInkProfile(registries, report);
  const versionSpecs = recommendVersions();

  const results = [];

  for (const spec of versionSpecs) {
    // Full Color version = the original colorized SVG, untouched
    if (spec.id === "v_full") {
      const fullPalette = inkProfile.inkColors.map((c) => ({ hex: c.hex, lab: c.lab, area: c.area }));
      results.push({
        id: spec.id,
        label: spec.label,
        maxColors: spec.maxColors,
        includeGradients: true,
        palette: fullPalette.map((p) => p.hex),
        svgString: svgSource,
        mapping: null,
      });
      continue;
    }

    const palette = extractPalette(inkProfile, spec.maxColors);
    const paintMapping = buildPaintMapping(inkProfile, palette, registries, report);

    const svgString = renderVersionSvg(
      svgSource,
      paintMapping,
      registries,
      report,
      spec.includeGradients
    );

    results.push({
      id: spec.id,
      label: spec.label,
      maxColors: spec.maxColors,
      includeGradients: spec.includeGradients,
      palette: palette.map((p) => p.hex),
      svgString,
      mapping: paintMapping,
    });
  }

  return results;
}
