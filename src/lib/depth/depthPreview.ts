import type { DepthConfidenceMap, DepthMap } from "./depthTypes";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function createDepthPreview(depth: DepthMap): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = depth.width;
  canvas.height = depth.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas indisponible pour la carte de profondeur.");

  const image = ctx.createImageData(depth.width, depth.height);
  for (let p = 0; p < depth.values.length; p += 1) {
    const d = clamp(depth.values[p], 0, 1);
    const i = p * 4;

    // Proche = chaud, lointain = bleu. Ce code couleur exprime uniquement
    // l'estimation relative de v0.1, jamais une distance réelle.
    image.data[i] = Math.round(245 * (1 - d) + 32 * d);
    image.data[i + 1] = Math.round(88 + 105 * (1 - Math.abs(d - 0.5) * 2));
    image.data[i + 2] = Math.round(45 * (1 - d) + 235 * d);
    image.data[i + 3] = 255;
  }

  ctx.putImageData(image, 0, 0);
  return canvas;
}

export function createConfidencePreview(confidence: DepthConfidenceMap): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = confidence.width;
  canvas.height = confidence.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas indisponible pour la carte de confiance.");

  const image = ctx.createImageData(confidence.width, confidence.height);
  for (let p = 0; p < confidence.values.length; p += 1) {
    const c = clamp(confidence.values[p], 0, 1);
    const i = p * 4;
    const value = Math.round(c * 255);
    image.data[i] = Math.round(value * 0.30);
    image.data[i + 1] = value;
    image.data[i + 2] = Math.round(value * 0.72);
    image.data[i + 3] = 255;
  }

  ctx.putImageData(image, 0, 0);
  return canvas;
}
