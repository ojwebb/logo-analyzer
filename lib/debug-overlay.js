// Debug overlay: visual debugging of paint groups and analysis decisions

const DEBUG_PALETTE = [
  "#e85d26", "#3b82f6", "#06d6a0", "#9b5de5", "#e9c46a",
  "#ef476f", "#00b4d8", "#f77f00", "#84a98c", "#d62828",
  "#4cc9f0", "#7209b7", "#f4a261", "#2a9d8f", "#e63946",
];

export function generateDebugColorMap(paintGroups) {
  const map = new Map();
  let colorIdx = 0;

  for (const group of paintGroups) {
    const color = DEBUG_PALETTE[colorIdx % DEBUG_PALETTE.length];
    for (const memberId of group.members) {
      map.set(memberId, color);
    }
    colorIdx++;
  }

  return map;
}

export function createDebugOverlay(svgEl, paths, debugColorMap) {
  const clone = svgEl.cloneNode(true);
  const allPaths = clone.querySelectorAll("path");

  for (const el of allPaths) {
    const id = el.getAttribute("id");
    // Try to match by iterating registered paths
    let debugColor = null;
    for (const [, pathEntry] of paths) {
      if (pathEntry.originalId === id) {
        const paintKey = pathEntry.fillPaint?.id;
        if (paintKey && debugColorMap.has(paintKey)) {
          debugColor = debugColorMap.get(paintKey);
        }
        break;
      }
    }
    if (debugColor) {
      el.setAttribute("fill", debugColor);
      el.setAttribute("fill-opacity", "0.6");
      el.setAttribute("stroke", debugColor);
      el.setAttribute("stroke-width", "0.5");
    }
  }

  return clone;
}

export function createShapeInfoPanel(pathId, report, registries) {
  const path = registries.paths.get(pathId);
  if (!path) return "<div>Shape not found</div>";

  const decision = report.decisions.find((d) => d.pathId === pathId);
  const cluster = report.clusters.find((c) => c.pathIds.includes(pathId));

  const lines = [];
  lines.push(`<strong>Shape:</strong> ${path.originalId} (${pathId})`);
  lines.push(`<strong>BBox:</strong> ${path.bbox.x.toFixed(1)}, ${path.bbox.y.toFixed(1)} — ${path.bbox.width.toFixed(1)}×${path.bbox.height.toFixed(1)}`);
  lines.push(`<strong>Area:</strong> ${path.area.toFixed(1)} | Z-index: ${path.zIndex}`);
  lines.push(`<strong>Fill:</strong> ${path.fillPaint.type === "solid" ? path.fillPaint.hex : path.fillPaint.type} (${path.fillPaint.raw})`);

  if (decision) {
    lines.push(`<strong>Classification:</strong> <span style="color:${decision.action === "background_delete" ? "#ef4444" : decision.action === "counter_hole" ? "#f59e0b" : "#22c55e"}">${decision.action}</span> (${(decision.confidence * 100).toFixed(0)}%)`);
    lines.push(`<strong>Reasons:</strong> ${decision.reasons.join(", ")}`);
  }

  if (cluster) {
    lines.push(`<strong>Cluster:</strong> ${cluster.type} (${cluster.id})`);
  }

  return lines.join("<br>");
}
