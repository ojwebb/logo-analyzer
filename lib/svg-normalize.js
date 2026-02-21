// SVG normalization: expand <use>, resolve styles, flatten transforms, convert primitives to paths

const SVG_NS = "http://www.w3.org/2000/svg";

// ─── Path data parser ───

function parsePathData(d) {
  if (!d) return [];
  const commands = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])\s*([^MmLlHhVvCcSsQqTtAaZz]*)/g;
  let m;
  while ((m = re.exec(d)) !== null) {
    const type = m[1];
    const args = m[2].trim()
      ? m[2].trim().split(/[\s,]+/).map(Number)
      : [];
    commands.push({ type, args });
  }
  return commands;
}

function serializePathData(commands) {
  return commands.map((c) => c.type + (c.args.length ? " " + c.args.join(" ") : "")).join(" ");
}

function applyMatrixToPoint(matrix, x, y) {
  return {
    x: matrix.a * x + matrix.c * y + matrix.e,
    y: matrix.b * x + matrix.d * y + matrix.f,
  };
}

function applyMatrixToPathData(commands, matrix) {
  const result = [];
  let cx = 0, cy = 0; // current point for relative commands
  let sx = 0, sy = 0; // subpath start

  for (const cmd of commands) {
    const { type, args } = cmd;
    const isRel = type === type.toLowerCase();
    const abs = type.toUpperCase();

    switch (abs) {
      case "M":
      case "L":
      case "T": {
        const newArgs = [];
        for (let i = 0; i < args.length; i += 2) {
          let ax = args[i], ay = args[i + 1];
          if (isRel) { ax += cx; ay += cy; }
          const p = applyMatrixToPoint(matrix, ax, ay);
          newArgs.push(p.x, p.y);
          cx = ax; cy = ay;
          if (abs === "M" && i === 0) { sx = ax; sy = ay; }
        }
        result.push({ type: abs, args: newArgs });
        break;
      }
      case "H": {
        const newArgs = [];
        for (let i = 0; i < args.length; i++) {
          let ax = args[i];
          if (isRel) ax += cx;
          const p = applyMatrixToPoint(matrix, ax, cy);
          newArgs.push(p.x, p.y);
          cx = ax;
        }
        result.push({ type: "L", args: newArgs });
        break;
      }
      case "V": {
        const newArgs = [];
        for (let i = 0; i < args.length; i++) {
          let ay = args[i];
          if (isRel) ay += cy;
          const p = applyMatrixToPoint(matrix, cx, ay);
          newArgs.push(p.x, p.y);
          cy = ay;
        }
        result.push({ type: "L", args: newArgs });
        break;
      }
      case "C": {
        const newArgs = [];
        for (let i = 0; i < args.length; i += 6) {
          let coords = args.slice(i, i + 6);
          if (isRel) {
            coords = [coords[0] + cx, coords[1] + cy, coords[2] + cx, coords[3] + cy, coords[4] + cx, coords[5] + cy];
          }
          for (let j = 0; j < 6; j += 2) {
            const p = applyMatrixToPoint(matrix, coords[j], coords[j + 1]);
            newArgs.push(p.x, p.y);
          }
          cx = coords[4]; cy = coords[5];
        }
        result.push({ type: "C", args: newArgs });
        break;
      }
      case "S": {
        const newArgs = [];
        for (let i = 0; i < args.length; i += 4) {
          let coords = args.slice(i, i + 4);
          if (isRel) {
            coords = [coords[0] + cx, coords[1] + cy, coords[2] + cx, coords[3] + cy];
          }
          for (let j = 0; j < 4; j += 2) {
            const p = applyMatrixToPoint(matrix, coords[j], coords[j + 1]);
            newArgs.push(p.x, p.y);
          }
          cx = coords[2]; cy = coords[3];
        }
        result.push({ type: "S", args: newArgs });
        break;
      }
      case "Q": {
        const newArgs = [];
        for (let i = 0; i < args.length; i += 4) {
          let coords = args.slice(i, i + 4);
          if (isRel) {
            coords = [coords[0] + cx, coords[1] + cy, coords[2] + cx, coords[3] + cy];
          }
          for (let j = 0; j < 4; j += 2) {
            const p = applyMatrixToPoint(matrix, coords[j], coords[j + 1]);
            newArgs.push(p.x, p.y);
          }
          cx = coords[2]; cy = coords[3];
        }
        result.push({ type: "Q", args: newArgs });
        break;
      }
      case "A": {
        // V1: convert arcs to approximate cubic beziers would be complex,
        // so we transform the endpoint and keep radii scaled by matrix determinant
        const newArgs = [];
        for (let i = 0; i < args.length; i += 7) {
          let rx = args[i], ry = args[i + 1], angle = args[i + 2];
          let largeArc = args[i + 3], sweep = args[i + 4];
          let ex = args[i + 5], ey = args[i + 6];
          if (isRel) { ex += cx; ey += cy; }
          const scale = Math.sqrt(Math.abs(matrix.a * matrix.d - matrix.b * matrix.c));
          const p = applyMatrixToPoint(matrix, ex, ey);
          newArgs.push(rx * scale, ry * scale, angle, largeArc, sweep, p.x, p.y);
          cx = ex; cy = ey;
        }
        result.push({ type: "A", args: newArgs });
        break;
      }
      case "Z": {
        result.push({ type: "Z", args: [] });
        cx = sx; cy = sy;
        break;
      }
      default:
        result.push({ type, args });
    }
  }
  return result;
}

// ─── Normalization steps ───

function expandUseReferences(svg) {
  const uses = [...svg.querySelectorAll("use")];
  for (const use of uses) {
    const href = use.getAttribute("href") || use.getAttributeNS("http://www.w3.org/1999/xlink", "href");
    if (!href) continue;
    const target = svg.querySelector(href);
    if (!target) continue;

    const clone = target.cloneNode(true);
    clone.removeAttribute("id");

    // Transfer x/y as translate
    const x = parseFloat(use.getAttribute("x")) || 0;
    const y = parseFloat(use.getAttribute("y")) || 0;
    const existingTransform = use.getAttribute("transform") || "";
    if (x || y) {
      clone.setAttribute("transform", `translate(${x},${y}) ${existingTransform}`.trim());
    } else if (existingTransform) {
      clone.setAttribute("transform", existingTransform);
    }

    use.parentNode.replaceChild(clone, use);
  }
}

function resolveComputedStyles(svg) {
  const INHERITED_PROPS = ["fill", "stroke", "stroke-width", "opacity", "fill-opacity", "stroke-opacity", "fill-rule", "clip-rule"];
  const els = svg.querySelectorAll("*");

  for (const el of els) {
    if (!el.ownerSVGElement && el.tagName !== "svg") continue;

    for (const prop of INHERITED_PROPS) {
      // Skip if already has explicit attribute
      if (el.getAttribute(prop)) continue;

      try {
        const computed = getComputedStyle(el);
        const val = computed.getPropertyValue(prop);
        if (val && val !== "none" && val !== "") {
          // Only set fill/stroke if meaningful
          if ((prop === "fill" || prop === "stroke") && (val === "rgb(0, 0, 0)" || val === "#000000")) {
            // Default black — only set if element is fillable
            const tag = el.tagName.toLowerCase();
            const fillable = ["path", "rect", "circle", "ellipse", "polygon", "polyline", "text"].includes(tag);
            if (fillable && prop === "fill" && !el.getAttribute("fill")) {
              el.setAttribute("fill", val);
            }
          } else if (val !== "rgb(0, 0, 0)") {
            el.setAttribute(prop, val);
          }
        }
      } catch {
        // getComputedStyle may fail for elements not in DOM
      }
    }
  }
}

function flattenTransforms(svg) {
  const els = svg.querySelectorAll("[transform]");
  for (const el of els) {
    const tag = el.tagName.toLowerCase();
    if (tag === "svg" || tag === "defs") continue;

    if (tag === "path") {
      try {
        const ctm = el.getCTM();
        const parentCtm = el.parentNode?.getCTM?.();
        if (!ctm) continue;

        // Get the local transform matrix
        let localMatrix = ctm;
        if (parentCtm) {
          const inv = parentCtm.inverse();
          localMatrix = inv.multiply(ctm);
        }

        const d = el.getAttribute("d");
        if (!d) continue;

        const commands = parsePathData(d);
        const transformed = applyMatrixToPathData(commands, localMatrix);
        el.setAttribute("d", serializePathData(transformed));
        el.removeAttribute("transform");
      } catch {
        // If transform flattening fails, leave it
      }
    } else if (tag === "g") {
      // Leave group transforms — they'll be handled when paths are processed
    }
  }
}

function rectToPath(el) {
  const x = parseFloat(el.getAttribute("x")) || 0;
  const y = parseFloat(el.getAttribute("y")) || 0;
  const w = parseFloat(el.getAttribute("width")) || 0;
  const h = parseFloat(el.getAttribute("height")) || 0;
  let rx = parseFloat(el.getAttribute("rx")) || 0;
  let ry = parseFloat(el.getAttribute("ry")) || rx;
  rx = Math.min(rx, w / 2);
  ry = Math.min(ry, h / 2);

  let d;
  if (rx > 0 || ry > 0) {
    d = `M ${x + rx} ${y} H ${x + w - rx} A ${rx} ${ry} 0 0 1 ${x + w} ${y + ry} V ${y + h - ry} A ${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h} H ${x + rx} A ${rx} ${ry} 0 0 1 ${x} ${y + h - ry} V ${y + ry} A ${rx} ${ry} 0 0 1 ${x + rx} ${y} Z`;
  } else {
    d = `M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`;
  }
  return d;
}

function circleToPath(el) {
  const cx = parseFloat(el.getAttribute("cx")) || 0;
  const cy = parseFloat(el.getAttribute("cy")) || 0;
  const r = parseFloat(el.getAttribute("r")) || 0;
  return `M ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy} Z`;
}

function ellipseToPath(el) {
  const cx = parseFloat(el.getAttribute("cx")) || 0;
  const cy = parseFloat(el.getAttribute("cy")) || 0;
  const rx = parseFloat(el.getAttribute("rx")) || 0;
  const ry = parseFloat(el.getAttribute("ry")) || 0;
  return `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`;
}

function polygonToPath(el) {
  const points = el.getAttribute("points")?.trim();
  if (!points) return "M 0 0 Z";
  const pairs = points.split(/[\s,]+/);
  let d = "";
  for (let i = 0; i < pairs.length; i += 2) {
    d += (i === 0 ? "M " : " L ") + pairs[i] + " " + pairs[i + 1];
  }
  return d + " Z";
}

function polylineToPath(el) {
  const points = el.getAttribute("points")?.trim();
  if (!points) return "M 0 0";
  const pairs = points.split(/[\s,]+/);
  let d = "";
  for (let i = 0; i < pairs.length; i += 2) {
    d += (i === 0 ? "M " : " L ") + pairs[i] + " " + pairs[i + 1];
  }
  return d;
}

function convertPrimitivesToPaths(svg) {
  const converters = {
    rect: rectToPath,
    circle: circleToPath,
    ellipse: ellipseToPath,
    polygon: polygonToPath,
    polyline: polylineToPath,
  };

  for (const [tag, converter] of Object.entries(converters)) {
    const els = [...svg.querySelectorAll(tag)];
    for (const el of els) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", converter(el));

      // Copy relevant attributes
      for (const attr of el.attributes) {
        const skip = ["x", "y", "width", "height", "rx", "ry", "cx", "cy", "r", "points"];
        if (!skip.includes(attr.name)) {
          path.setAttribute(attr.name, attr.value);
        }
      }

      // Tag with original element type for debugging
      path.setAttribute("data-original-tag", tag);
      el.parentNode.replaceChild(path, el);
    }
  }
}

function splitCompoundPaths(svg) {
  const paths = [...svg.querySelectorAll("path")];
  for (const path of paths) {
    const d = path.getAttribute("d");
    if (!d) continue;

    // Count M commands — if >1, this is a compound path
    const mCount = (d.match(/[Mm]/g) || []).length;
    if (mCount <= 1) continue;

    // Parse into subpaths
    const subpaths = [];
    let current = "";
    const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz][^MmLlHhVvCcSsQqTtAaZz]*/g) || [];

    for (const token of tokens) {
      const cmd = token[0];
      if ((cmd === "M" || cmd === "m") && current) {
        subpaths.push(current.trim());
        current = "";
      }
      current += token;
    }
    if (current.trim()) subpaths.push(current.trim());

    if (subpaths.length <= 1) continue;

    // Create group to hold subpaths, preserving compound id
    const compoundId = path.getAttribute("id") || "";
    const group = document.createElementNS(SVG_NS, "g");
    group.setAttribute("data-compound-source", compoundId || "true");

    subpaths.forEach((sub, i) => {
      const sp = document.createElementNS(SVG_NS, "path");
      sp.setAttribute("d", sub);
      // Copy non-geometric attributes
      for (const attr of path.attributes) {
        if (attr.name !== "d" && attr.name !== "id") {
          sp.setAttribute(attr.name, attr.value);
        }
      }
      sp.setAttribute("data-subpath-index", String(i));
      if (compoundId) sp.setAttribute("data-compound-parent", compoundId);
      group.appendChild(sp);
    });

    path.parentNode.replaceChild(group, path);
  }
}

// ─── Main orchestrator ───

export function normalizeSvg(svgEl) {
  const clone = svgEl.cloneNode(true);

  // Must be in DOM for geometry APIs to work
  const container = document.createElement("div");
  container.style.cssText = "position:absolute;left:-9999px;top:-9999px;visibility:hidden;width:600px;height:600px";
  document.body.appendChild(container);
  container.appendChild(clone);

  try {
    expandUseReferences(clone);
    resolveComputedStyles(clone);
    convertPrimitivesToPaths(clone);
    flattenTransforms(clone);
    splitCompoundPaths(clone);
  } finally {
    document.body.removeChild(container);
  }

  return clone;
}
