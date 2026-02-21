// Shape clustering: icon vs wordmark identification

import { distance, bboxCenter, bboxAspectRatio, getViewBox } from "./geometry-utils";

// Single-linkage agglomerative clustering by spatial proximity
function proximityClustering(items, threshold) {
  if (items.length === 0) return [];
  const clusters = items.map((item, i) => ({ id: i, members: [item] }));
  const active = new Set(clusters.map((c) => c.id));

  while (active.size > 1) {
    let bestDist = Infinity, bestA = -1, bestB = -1;
    const ids = [...active];

    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const ca = clusters[ids[i]], cb = clusters[ids[j]];
        for (const ma of ca.members) {
          for (const mb of cb.members) {
            const d = distance(ma.centroid, mb.centroid);
            if (d < bestDist) { bestDist = d; bestA = ids[i]; bestB = ids[j]; }
          }
        }
      }
    }

    if (bestDist > threshold) break;
    clusters[bestA].members.push(...clusters[bestB].members);
    active.delete(bestB);
  }

  return [...active].map((id) => clusters[id].members);
}

function classifyCluster(members, viewBox) {
  // Compute bounding box of entire cluster
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const m of members) {
    minX = Math.min(minX, m.bbox.x);
    minY = Math.min(minY, m.bbox.y);
    maxX = Math.max(maxX, m.bbox.x + m.bbox.width);
    maxY = Math.max(maxY, m.bbox.y + m.bbox.height);
  }
  const clusterBbox = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  const ar = bboxAspectRatio(clusterBbox);

  let type = "unknown";
  let confidence = 0.5;

  if (ar > 3.0) {
    type = "wordmark";
    confidence = 0.85;
  } else if (ar > 2.0 && members.length > 5) {
    type = "wordmark";
    confidence = 0.65;
  } else if (ar < 2.0 && members.length <= 8) {
    type = "icon";
    confidence = 0.7;
  } else if (ar < 1.5) {
    type = "icon";
    confidence = 0.8;
  }

  return { type, confidence, bbox: clusterBbox, aspectRatio: ar, memberCount: members.length };
}

export function clusterShapes(paths, paints, viewBox, gptAnalysis) {
  // Filter out background/none-fill paths
  const candidates = [];
  for (const [id, path] of paths) {
    if (path.fillPaint.type === "none") continue;
    if (path.area < 1) continue; // skip invisible paths
    candidates.push({
      id,
      centroid: path.centroid,
      bbox: path.bbox,
      area: path.area,
      originalId: path.originalId,
    });
  }

  if (candidates.length === 0) return [];

  // Determine clustering threshold based on viewBox diagonal
  const diagonal = Math.sqrt(viewBox.width ** 2 + viewBox.height ** 2);
  const threshold = diagonal * 0.15; // 15% of diagonal

  const clusters = proximityClustering(candidates, threshold);

  // Classify each cluster
  const results = clusters.map((members, i) => {
    const info = classifyCluster(members, viewBox);
    return {
      id: `cluster_${i}`,
      ...info,
      pathIds: members.map((m) => m.id),
      originalIds: members.map((m) => m.originalId),
    };
  });

  // Use GPT hints to refine if available
  if (gptAnalysis) {
    const iconHints = new Set(gptAnalysis.iconPaths || []);
    const wordmarkHints = new Set(gptAnalysis.wordmarkPaths || []);

    for (const cluster of results) {
      const originalIds = cluster.originalIds;
      const iconOverlap = originalIds.filter((id) => iconHints.has(id)).length;
      const wordmarkOverlap = originalIds.filter((id) => wordmarkHints.has(id)).length;

      if (iconOverlap > wordmarkOverlap && iconOverlap > 0) {
        cluster.type = "icon";
        cluster.confidence = Math.max(cluster.confidence, 0.8);
        cluster.gptReinforced = true;
      } else if (wordmarkOverlap > iconOverlap && wordmarkOverlap > 0) {
        cluster.type = "wordmark";
        cluster.confidence = Math.max(cluster.confidence, 0.8);
        cluster.gptReinforced = true;
      }
    }
  }

  // Sort: icon clusters first, then wordmark
  results.sort((a, b) => {
    if (a.type === "icon" && b.type !== "icon") return -1;
    if (a.type !== "icon" && b.type === "icon") return 1;
    return 0;
  });

  return results;
}
