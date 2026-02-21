// Geometry helpers using browser SVG DOM APIs

export function getViewBox(svgEl) {
  const vb = svgEl.getAttribute("viewBox");
  if (vb) {
    const p = vb.split(/[\s,]+/).map(Number);
    if (p.length >= 4) return { x: p[0], y: p[1], width: p[2], height: p[3] };
  }
  const w = parseFloat(svgEl.getAttribute("width")) || 300;
  const h = parseFloat(svgEl.getAttribute("height")) || 150;
  return { x: 0, y: 0, width: w, height: h };
}

export function geometryFingerprint(el) {
  try {
    const bbox = el.getBBox();
    const area = bbox.width * bbox.height;
    const centroid = { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 };
    let perimeter = 0;
    let pointHash = 0;

    if (typeof el.getTotalLength === "function") {
      perimeter = el.getTotalLength();
      // Sample points along path for fingerprint
      const steps = Math.min(16, Math.max(4, Math.floor(perimeter / 10)));
      for (let i = 0; i < steps; i++) {
        const pt = el.getPointAtLength((i / steps) * perimeter);
        pointHash = ((pointHash * 31) + Math.round(pt.x * 100) + Math.round(pt.y * 100)) | 0;
      }
    }

    return { bbox, area, centroid, perimeter, pointHash };
  } catch {
    return { bbox: { x: 0, y: 0, width: 0, height: 0 }, area: 0, centroid: { x: 0, y: 0 }, perimeter: 0, pointHash: 0 };
  }
}

export function bboxContains(outer, inner) {
  const margin = 0.5;
  return (
    inner.x >= outer.x - margin &&
    inner.y >= outer.y - margin &&
    inner.x + inner.width <= outer.x + outer.width + margin &&
    inner.y + inner.height <= outer.y + outer.height + margin
  );
}

export function bboxOverlap(a, b) {
  const overlapX = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const overlapY = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return overlapX * overlapY;
}

export function isPointInShape(el, x, y) {
  try {
    const svg = el.ownerSVGElement;
    if (!svg) return false;
    const pt = svg.createSVGPoint();
    pt.x = x;
    pt.y = y;
    if (typeof el.isPointInFill === "function") {
      return el.isPointInFill(pt);
    }
    // Fallback: bbox check
    const bbox = el.getBBox();
    return x >= bbox.x && x <= bbox.x + bbox.width && y >= bbox.y && y <= bbox.y + bbox.height;
  } catch {
    return false;
  }
}

export function isShapeContainedIn(containerEl, containedEl) {
  try {
    const inner = containedEl.getBBox();
    const outer = containerEl.getBBox();
    if (!bboxContains(outer, inner)) return false;

    // Sample points from inner shape and check if they fall inside container
    const samples = 8;
    let inside = 0;
    for (let i = 0; i < samples; i++) {
      const x = inner.x + (inner.width * (i + 1)) / (samples + 1);
      const y = inner.y + inner.height / 2;
      if (isPointInShape(containerEl, x, y)) inside++;
    }
    return inside >= samples * 0.7;
  } catch {
    return false;
  }
}

export function touchesViewBoxEdge(shapeBbox, viewBox) {
  const margin = viewBox.width * 0.02;
  return {
    top: shapeBbox.y <= viewBox.y + margin,
    right: shapeBbox.x + shapeBbox.width >= viewBox.x + viewBox.width - margin,
    bottom: shapeBbox.y + shapeBbox.height >= viewBox.y + viewBox.height - margin,
    left: shapeBbox.x <= viewBox.x + margin,
    get any() { return this.top || this.right || this.bottom || this.left; },
  };
}

export function areaRatio(shapeBbox, viewBox) {
  const shapeArea = shapeBbox.width * shapeBbox.height;
  const vbArea = viewBox.width * viewBox.height;
  return vbArea > 0 ? shapeArea / vbArea : 0;
}

export function distance(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

export function bboxCenter(bbox) {
  return { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 };
}

export function bboxAspectRatio(bbox) {
  return bbox.height > 0 ? bbox.width / bbox.height : 1;
}
