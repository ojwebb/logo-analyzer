// Gradient classification: simple vs complex

export function classifyGradient(paint) {
  if (!paint || paint.type === "solid" || paint.type === "none") {
    return { type: "not_gradient", confidence: 1, canRecreateVector: true };
  }

  if (paint.type === "complex_mesh") {
    return { type: "complex_mesh", confidence: 0.9, canRecreateVector: false };
  }

  const stops = paint.stops || [];

  if (stops.length === 0) {
    return { type: "unknown", confidence: 0.5, canRecreateVector: false };
  }

  // Simple: ≤5 stops, no pattern refs, standard gradient type
  if (stops.length <= 5) {
    const hasPatternRef = stops.some((s) => s.color.startsWith("url("));
    if (hasPatternRef) {
      return { type: "textured", confidence: 0.8, canRecreateVector: false };
    }

    if (paint.type === "linear") {
      return {
        type: "simple_linear",
        confidence: 0.95,
        canRecreateVector: true,
        stopCount: stops.length,
      };
    }
    if (paint.type === "radial") {
      return {
        type: "simple_radial",
        confidence: 0.95,
        canRecreateVector: true,
        stopCount: stops.length,
      };
    }
  }

  // >5 stops but still a standard gradient element
  if (paint.type === "linear") {
    return {
      type: "simple_linear",
      confidence: 0.7,
      canRecreateVector: true,
      stopCount: stops.length,
      note: "Many stops — may be approximating a complex gradient",
    };
  }
  if (paint.type === "radial") {
    return {
      type: "simple_radial",
      confidence: 0.7,
      canRecreateVector: true,
      stopCount: stops.length,
      note: "Many stops — may be approximating a complex gradient",
    };
  }

  return { type: "textured", confidence: 0.5, canRecreateVector: false };
}
