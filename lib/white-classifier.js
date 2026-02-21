// White region classification: background_delete | interior_keep | counter_hole | unknown_review

import { isWhiteLike, parseColor } from "./color-utils";
import { bboxContains, areaRatio, touchesViewBoxEdge, isShapeContainedIn, bboxOverlap } from "./geometry-utils";

// ─── Containment graph ───

export function buildContainmentGraph(paths, svgForPointTests) {
  const graph = new Map();
  const entries = [...paths.values()];

  for (const p of entries) {
    graph.set(p.id, { containedBy: [], contains: [] });
  }

  // For each pair, check bbox containment, then sample-point containment
  for (let i = 0; i < entries.length; i++) {
    for (let j = 0; j < entries.length; j++) {
      if (i === j) continue;
      const outer = entries[i];
      const inner = entries[j];

      if (!bboxContains(outer.bbox, inner.bbox)) continue;

      // Check area ratio — inner must be significantly smaller
      const innerArea = inner.bbox.width * inner.bbox.height;
      const outerArea = outer.bbox.width * outer.bbox.height;
      if (outerArea > 0 && innerArea / outerArea > 0.95) continue;

      // Sample-point containment check
      if (outer.el && inner.el) {
        try {
          if (isShapeContainedIn(outer.el, inner.el)) {
            graph.get(inner.id).containedBy.push(outer.id);
            graph.get(outer.id).contains.push(inner.id);
          }
        } catch {
          // Fallback: bbox containment is sufficient
          graph.get(inner.id).containedBy.push(outer.id);
          graph.get(outer.id).contains.push(inner.id);
        }
      }
    }
  }

  return graph;
}

// ─── Background plate detection ───

export function detectBackgroundPlate(paths, paints, viewBox) {
  let bestCandidate = null;
  let bestScore = 0;

  for (const [id, path] of paths) {
    const ratio = areaRatio(path.bbox, viewBox);
    if (ratio < 0.7) continue;

    const fill = path.fillPaint;
    if (fill.type === "none") continue;

    // Check if it's on the bottom layer (low z-index)
    const zScore = path.zIndex <= 2 ? 1 : path.zIndex <= 5 ? 0.5 : 0.2;

    // Check if it touches viewBox edges
    const edges = touchesViewBoxEdge(path.bbox, viewBox);
    const edgeScore = (edges.top ? 0.25 : 0) + (edges.right ? 0.25 : 0) + (edges.bottom ? 0.25 : 0) + (edges.left ? 0.25 : 0);

    // White-like fills are more likely backgrounds
    const isWhite = fill.type === "solid" && isWhiteLike(fill.rgba);
    const colorScore = isWhite ? 1 : 0.3;

    const score = ratio * 0.3 + zScore * 0.3 + edgeScore * 0.2 + colorScore * 0.2;

    if (score > bestScore) {
      bestScore = score;
      bestCandidate = { id, score, ratio, isWhite, zIndex: path.zIndex };
    }
  }

  return bestScore > 0.6 ? bestCandidate : null;
}

// ─── Shape classification ───

function isPathWhiteFilled(path) {
  const fill = path.fillPaint;
  if (fill.type !== "solid") return false;
  return isWhiteLike(fill.rgba);
}

function getContainingNonWhitePaths(pathId, paths, graph) {
  const node = graph.get(pathId);
  if (!node) return [];
  return node.containedBy.filter((containerId) => {
    const container = paths.get(containerId);
    return container && !isPathWhiteFilled(container);
  });
}

function isLikelyLetterCounter(pathId, paths, graph) {
  // A counter is a white shape inside a letter (like the hole in O, A, D, etc.)
  const node = graph.get(pathId);
  if (!node) return false;

  // Must be contained by at least one non-white shape
  const nonWhiteContainers = getContainingNonWhitePaths(pathId, paths, graph);
  if (nonWhiteContainers.length === 0) return false;

  // The containing shape should not contain too many other shapes (letters are relatively simple)
  for (const containerId of nonWhiteContainers) {
    const containerNode = graph.get(containerId);
    if (containerNode && containerNode.contains.length <= 5) {
      return true;
    }
  }
  return false;
}

function isCompoundSubpath(path, paths) {
  if (!path.compoundParent) return false;
  // If this is a subpath of a compound path, it may be a hole
  // Check if sibling subpaths exist
  let siblingCount = 0;
  for (const [, p] of paths) {
    if (p.compoundParent === path.compoundParent && p.id !== path.id) {
      siblingCount++;
    }
  }
  return siblingCount > 0;
}

export function classifyWhiteShape(pathId, paths, paints, graph, viewBox, backgroundPlateId) {
  const path = paths.get(pathId);
  if (!path) return { classification: "unknown_review", confidence: 0, reasons: ["path not found"] };

  const reasons = [];

  // Rule 1: Is this the detected background plate?
  if (backgroundPlateId && pathId === backgroundPlateId) {
    return {
      classification: "background_delete",
      confidence: 0.95,
      reasons: ["detected as background plate"],
    };
  }

  // Rule 2: Large area + bottom layer + touches edges = background
  const ratio = areaRatio(path.bbox, viewBox);
  const edges = touchesViewBoxEdge(path.bbox, viewBox);
  if (ratio > 0.85 && path.zIndex <= 2 && edges.any) {
    return {
      classification: "background_delete",
      confidence: 0.9,
      reasons: [`covers ${(ratio * 100).toFixed(0)}% of viewBox`, `z-index ${path.zIndex}`, "touches edges"],
    };
  }

  // Rule 3: Compound subpath (hole in letter/icon)
  if (isCompoundSubpath(path, paths)) {
    const parentId = path.compoundParent;
    reasons.push(`subpath of compound "${parentId}"`);

    // If the parent subpath is non-white, this is likely a counter/hole
    const siblings = [...paths.values()].filter(
      (p) => p.compoundParent === path.compoundParent && p.id !== pathId
    );
    const nonWhiteSiblings = siblings.filter((s) => !isPathWhiteFilled(s));
    if (nonWhiteSiblings.length > 0) {
      return {
        classification: "counter_hole",
        confidence: 0.85,
        reasons: [...reasons, "sibling subpaths are non-white"],
      };
    }
  }

  // Rule 4: Enclosed by non-white shape = interior detail or counter
  const node = graph.get(pathId);
  const nonWhiteContainers = getContainingNonWhitePaths(pathId, paths, graph);

  if (nonWhiteContainers.length > 0) {
    // Check if likely a letter counter
    if (isLikelyLetterCounter(pathId, paths, graph)) {
      return {
        classification: "counter_hole",
        confidence: 0.8,
        reasons: ["enclosed by non-white shape", "likely letter counter"],
      };
    }

    // Otherwise it's an interior keep (white detail within colored shape)
    return {
      classification: "interior_keep",
      confidence: 0.75,
      reasons: ["enclosed by non-white shape", "interior detail"],
    };
  }

  // Rule 5: Moderate size, touches some edges, not clearly contained = likely background
  if (ratio > 0.3 && edges.any && path.zIndex <= 3) {
    return {
      classification: "background_delete",
      confidence: 0.65,
      reasons: [`covers ${(ratio * 100).toFixed(0)}% of viewBox`, "touches edges", "low z-index"],
    };
  }

  // Rule 6: Small isolated white shape — could be anything
  if (ratio < 0.05) {
    return {
      classification: "interior_keep",
      confidence: 0.5,
      reasons: ["small isolated white shape", "defaulting to keep"],
    };
  }

  return {
    classification: "unknown_review",
    confidence: 0.3,
    reasons: ["no strong classification signal"],
  };
}

// ─── Main classifier ───

export function classifyWhiteRegions(paths, paints, bindings, svgEl) {
  const viewBox = svgEl ? (() => {
    const vb = svgEl.getAttribute("viewBox");
    if (vb) {
      const p = vb.split(/[\s,]+/).map(Number);
      if (p.length >= 4) return { x: p[0], y: p[1], width: p[2], height: p[3] };
    }
    return { x: 0, y: 0, width: 300, height: 150 };
  })() : { x: 0, y: 0, width: 300, height: 150 };

  // Build containment graph
  const graph = buildContainmentGraph(paths, svgEl);

  // Detect background plate
  const backgroundPlate = detectBackgroundPlate(paths, paints, viewBox);
  const backgroundPlateId = backgroundPlate?.id || null;

  // Classify each white-filled path
  const results = [];

  for (const [id, path] of paths) {
    if (!isPathWhiteFilled(path)) continue;

    const result = classifyWhiteShape(id, paths, paints, graph, viewBox, backgroundPlateId);
    results.push({
      pathId: id,
      originalId: path.originalId,
      ...result,
    });
  }

  return {
    regions: results,
    backgroundPlateId,
    backgroundPlate,
    containmentGraph: graph,
  };
}
