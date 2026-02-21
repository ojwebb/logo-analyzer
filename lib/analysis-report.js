// Analysis report generation and GPT prompt hint formatting

import { classifyGradient } from "./gradient-classifier";
import { isWhiteLike, rgbToHex, rgbToLab } from "./color-utils";

export function generateReport(registries, whiteResults, clusters) {
  const { paths, paints, paintGroups, viewBox } = registries;

  const decisions = [];

  // White region decisions
  for (const wr of whiteResults.regions) {
    decisions.push({
      pathId: wr.pathId,
      originalId: wr.originalId,
      action: wr.classification,
      confidence: wr.confidence,
      reasons: wr.reasons,
      source: "white_classifier",
    });
  }

  // Gradient classification for each gradient paint
  const gradientInfo = [];
  for (const [, paint] of paints) {
    if (paint.type === "linear" || paint.type === "radial" || paint.type === "complex_mesh") {
      gradientInfo.push({
        paintId: paint.id,
        ...classifyGradient(paint),
      });
    }
  }

  // Summary
  const pathCount = paths.size;
  const paintCount = paints.size;
  const whiteCount = whiteResults.regions.length;
  const bgCount = whiteResults.regions.filter((r) => r.classification === "background_delete").length;
  const counterCount = whiteResults.regions.filter((r) => r.classification === "counter_hole").length;
  const keepCount = whiteResults.regions.filter((r) => r.classification === "interior_keep").length;
  const reviewCount = whiteResults.regions.filter((r) => r.classification === "unknown_review").length;
  const clusterCount = clusters.length;
  const iconClusters = clusters.filter((c) => c.type === "icon").length;
  const wordmarkClusters = clusters.filter((c) => c.type === "wordmark").length;

  return {
    decisions,
    backgroundPlateId: whiteResults.backgroundPlateId,
    backgroundPlate: whiteResults.backgroundPlate,
    clusters,
    whiteRegions: whiteResults.regions,
    paintGroups,
    gradientInfo,
    viewBox,
    summary: {
      pathCount,
      paintCount,
      paintGroupCount: paintGroups.length,
      whiteRegionCount: whiteCount,
      backgroundDeleteCount: bgCount,
      counterHoleCount: counterCount,
      interiorKeepCount: keepCount,
      unknownReviewCount: reviewCount,
      clusterCount,
      iconClusterCount: iconClusters,
      wordmarkClusterCount: wordmarkClusters,
    },
  };
}

export function reportToPromptHints(report) {
  const lines = [];
  lines.push("=== STRUCTURAL ANALYSIS HINTS ===");

  // Background plates
  const bgDecisions = report.decisions.filter((d) => d.action === "background_delete");
  if (bgDecisions.length > 0) {
    lines.push("");
    lines.push("BACKGROUND SHAPES (assign fill=\"none\" or delete — these are background plates, not logo content):");
    for (const d of bgDecisions) {
      lines.push(`  - ${d.originalId} (confidence: ${(d.confidence * 100).toFixed(0)}%, ${d.reasons.join(", ")})`);
    }
  }

  // Counter holes
  const counterDecisions = report.decisions.filter((d) => d.action === "counter_hole");
  if (counterDecisions.length > 0) {
    lines.push("");
    lines.push("COUNTER/HOLE SHAPES (these are cutouts in letters like O, A, D — assign fill=\"#ffffff\" or make transparent):");
    for (const d of counterDecisions) {
      lines.push(`  - ${d.originalId} (confidence: ${(d.confidence * 100).toFixed(0)}%)`);
    }
  }

  // Interior keeps
  const keepDecisions = report.decisions.filter((d) => d.action === "interior_keep");
  if (keepDecisions.length > 0) {
    lines.push("");
    lines.push("INTERIOR WHITE SHAPES (keep — these are intentional white details within the logo):");
    for (const d of keepDecisions) {
      lines.push(`  - ${d.originalId}`);
    }
  }

  // Unknown
  const unknownDecisions = report.decisions.filter((d) => d.action === "unknown_review");
  if (unknownDecisions.length > 0) {
    lines.push("");
    lines.push("AMBIGUOUS SHAPES (use your best judgment based on the original image):");
    for (const d of unknownDecisions) {
      lines.push(`  - ${d.originalId}`);
    }
  }

  // Clusters
  if (report.clusters.length > 0) {
    lines.push("");
    lines.push("SHAPE CLUSTERS:");
    for (const c of report.clusters) {
      lines.push(`  - ${c.type} cluster: ${c.originalIds.join(", ")} (${c.memberCount} shapes, aspect ratio ${c.aspectRatio.toFixed(1)})`);
    }
  }

  // Paint groups
  const solidGroups = report.paintGroups.filter((g) => g.type === "solid_cluster" && g.members.length > 1);
  if (solidGroups.length > 0) {
    lines.push("");
    lines.push("SIMILAR COLOR GROUPS (these shapes likely share the same color — keep consistent):");
    for (const g of solidGroups) {
      const rep = g.representative;
      lines.push(`  - Group: ${g.members.join(", ")} → representative color: ${rep.hex || rep.raw}`);
    }
  }

  lines.push("");
  lines.push(`Summary: ${report.summary.pathCount} paths, ${report.summary.paintGroupCount} paint groups, ${report.summary.whiteRegionCount} white regions (${report.summary.backgroundDeleteCount} bg, ${report.summary.counterHoleCount} counters, ${report.summary.interiorKeepCount} keep)`);

  return lines.join("\n");
}

export function extractColorInventory(registries, report) {
  const { paths, paints, paintGroups } = registries;
  const decisions = report.decisions || [];

  const excludedPathIds = new Set();
  for (const d of decisions) {
    if (d.action === "background_delete" || d.action === "counter_hole") {
      excludedPathIds.add(d.pathId);
    }
  }

  const inkColors = [];
  const backgroundColors = [];
  const counterColors = [];
  let gradientPresent = false;

  for (const group of paintGroups) {
    const rep = group.representative;
    if (!rep || rep.type === "none") continue;

    if (rep.type === "linear" || rep.type === "radial") {
      gradientPresent = true;
    }

    // Check if all paths in this group are excluded
    let allExcluded = true;
    let totalArea = 0;
    for (const memberId of group.members) {
      for (const [, path] of paths) {
        if (path.fillPaint?.id === memberId) {
          totalArea += path.area;
          if (!excludedPathIds.has(path.id)) allExcluded = false;
        }
      }
    }

    const hex = rep.hex || (rep.rgba ? rgbToHex(rep.rgba) : "#000000");
    const entry = { groupId: group.id, hex, area: totalArea, type: rep.type };

    if (rep.type === "solid" && rep.rgba && isWhiteLike(rep.rgba)) {
      if (allExcluded) backgroundColors.push(entry);
      else counterColors.push(entry);
      continue;
    }

    if (allExcluded) {
      backgroundColors.push(entry);
    } else {
      inkColors.push(entry);
    }
  }

  inkColors.sort((a, b) => b.area - a.area);

  return { inkColors, backgroundColors, counterColors, gradientPresent, inkCount: inkColors.length };
}
