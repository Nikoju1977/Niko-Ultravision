import type { DepthConfidenceMap, DepthMap } from "./depthTypes";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function buildDepthConfidenceMap(
  depth: DepthMap,
  structure: DepthMap,
): DepthConfidenceMap {
  if (depth.width !== structure.width || depth.height !== structure.height) {
    throw new Error("Cartes de profondeur et de structure incompatibles.");
  }

  const { width, height } = depth;
  const values = new Float32Array(width * height);

  for (let y = 1; y < height - 1; y += 1) {
    const row = y * width;
    for (let x = 1; x < width - 1; x += 1) {
      const p = row + x;
      const d = depth.values[p];
      const localSpread =
        Math.abs(d - depth.values[p - 1]) +
        Math.abs(d - depth.values[p + 1]) +
        Math.abs(d - depth.values[p - width]) +
        Math.abs(d - depth.values[p + width]);

      const consistency = clamp(1 - localSpread * 1.8, 0, 1);
      const structureEvidence = structure.values[p];
      // Une zone structurée ET cohérente est très fiable. Une zone plate mais
      // stable garde une confiance minimale plutôt que d'être rejetée.
      values[p] = clamp(
        0.22 + consistency * 0.40 + structureEvidence * 0.38,
        0,
        1,
      );
    }
  }

  for (let x = 0; x < width; x += 1) {
    values[x] = values[width + Math.min(width - 1, x)];
    values[(height - 1) * width + x] = values[(height - 2) * width + x];
  }
  for (let y = 0; y < height; y += 1) {
    values[y * width] = values[y * width + 1];
    values[y * width + width - 1] = values[y * width + width - 2];
  }

  return { width, height, values };
}
