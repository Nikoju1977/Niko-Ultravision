/**
 * Étape 1 — Analyse : bruit, flou, contraste, clipping, netteté, blocs JPEG,
 * couleur. Étape « routage » : choix des candidats selon le type d'image.
 *
 * Les mesures de bruit, netteté et blocs sont faites sur un recadrage à la
 * résolution native (le sous-échantillonnage masquerait justement bruit et
 * artefacts) ; contraste, clipping et couleur sur une vue réduite complète.
 */
import {
  canvas2d,
  gradientEnergy,
  jpegBlockiness,
  laplacianVariance,
  lumaOf,
  noiseSigma,
  resample,
} from "./imageMath";
import type { RestorationModelId } from "./modelRegistry";

export type ImageRoute = "clean-small" | "noisy" | "blurry" | "jpeg" | "old-photo" | "clean";

export interface ImageDiagnosis {
  width: number;
  height: number;
  megapixels: number;
  /** Écart-type du bruit estimé, unités 0–255. */
  noise: number;
  /** Variance du laplacien (netteté). */
  sharpness: number;
  gradient: number;
  /** Rapport de blocs 8×8 (≈1 = aucun, >1,3 = visible). */
  blockiness: number;
  /** Étendue tonale p1–p99, 0–255. */
  contrast: number;
  clippedShadows: number;
  clippedHighlights: number;
  /** Colorimétrie (Hasler–Süsstrunk). */
  colorfulness: number;
  /** Variation chromatique hors teinte moyenne. Faible = N&B, sépia, virage. */
  colorVariation: number;
  isJpegFile: boolean;
  route: ImageRoute;
  reasons: string[];
}

export interface RoutePlan {
  route: ImageRoute;
  label: string;
  models: RestorationModelId[];
  /** Force d'accentuation classique finale (étape 7 « micro-détails »). */
  finishSharpen: number;
}

function nativeCrop(source: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
  const side = Math.min(768, width, height);
  const x = Math.floor((width - side) / 2);
  const y = Math.floor((height - side) / 2);
  // Recadrage aligné sur la grille 8×8 d'origine pour la mesure des blocs JPEG.
  const ax = x - (x % 8);
  const ay = y - (y % 8);
  const { canvas, ctx } = canvas2d(side, side);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(source, ax, ay, side, side, 0, 0, side, side);
  return canvas;
}

function tonalStats(view: HTMLCanvasElement) {
  const ctx = view.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas 2D indisponible.");
  const { data } = ctx.getImageData(0, 0, view.width, view.height);
  const hist = new Uint32Array(256);
  let low = 0, high = 0;
  let rgSum = 0, ybSum = 0, rgSq = 0, ybSq = 0;
  let rnSum = 0, bnSum = 0, rnSq = 0, bnSq = 0;
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const y = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    hist[y] += 1;
    if (y <= 2) low += 1;
    if (y >= 253) high += 1;
    const rg = r - g;
    const yb = 0.5 * (r + g) - b;
    rgSum += rg; ybSum += yb; rgSq += rg * rg; ybSq += yb * yb;
    // Chromaticité normalisée : insensible à la luminosité, donc au virage
    // sépia (teinte proportionnelle à la luminance).
    const total = r + g + b + 1;
    const rn = r / total;
    const bn = b / total;
    rnSum += rn; bnSum += bn; rnSq += rn * rn; bnSq += bn * bn;
  }
  const percentile = (p: number) => {
    let acc = 0;
    const limit = n * p;
    for (let v = 0; v < 256; v += 1) {
      acc += hist[v];
      if (acc >= limit) return v;
    }
    return 255;
  };
  const rgMean = rgSum / n, ybMean = ybSum / n;
  const rgStd = Math.sqrt(Math.max(0, rgSq / n - rgMean * rgMean));
  const ybStd = Math.sqrt(Math.max(0, ybSq / n - ybMean * ybMean));
  return {
    contrast: percentile(0.99) - percentile(0.01),
    clippedShadows: low / n,
    clippedHighlights: high / n,
    colorfulness: Math.sqrt(rgStd ** 2 + ybStd ** 2) + 0.3 * Math.sqrt(rgMean ** 2 + ybMean ** 2),
    // Variation de chromaticité ×100 : ≈0,5 N&B/sépia, >6,5 photo couleur.
    colorVariation:
      100 *
      Math.sqrt(
        Math.max(0, rnSq / n - (rnSum / n) ** 2) + Math.max(0, bnSq / n - (bnSum / n) ** 2),
      ),
  };
}

export function diagnoseImage(
  source: CanvasImageSource,
  width: number,
  height: number,
  file: File,
  requestedScale: number,
): ImageDiagnosis {
  const crop = lumaOf(nativeCrop(source, width, height));
  const noise = noiseSigma(crop);
  const sharpness = laplacianVariance(crop);
  const gradient = gradientEnergy(crop);
  const blockiness = jpegBlockiness(crop);

  const viewScale = Math.min(1, 640 / Math.max(width, height));
  const view = resample(source, 0, 0, width, height, width * viewScale, height * viewScale);
  const tonal = tonalStats(view);
  // Couleur mesurée sur une vue minuscule : le bruit chromatique s'y moyenne,
  // seule reste la vraie variation de teinte de la scène.
  const tinyScale = Math.min(1, 96 / Math.max(width, height));
  const tiny = tonalStats(resample(source, 0, 0, width, height, width * tinyScale, height * tinyScale));
  tonal.colorVariation = tiny.colorVariation;

  const isJpegFile = /jpe?g$/i.test(file.type) || /\.jpe?g$/i.test(file.name);
  const megapixels = (width * height) / 1_000_000;
  const reasons: string[] = [];

  // Netteté relative au contenu : un gradient faible avec un laplacien faible
  // signale un flou, pas seulement une scène plate.
  const blurIndex = sharpness / Math.max(1, gradient * gradient);

  let route: ImageRoute;
  if (tonal.colorVariation < 5.5 && (noise > 3 || tonal.contrast < 190)) {
    route = "old-photo";
    reasons.push(
      `teinte uniforme (variation chromatique ${tonal.colorVariation.toFixed(1)}) et tonalité usée (étendue ${tonal.contrast}) : photo ancienne probable`,
    );
  } else if (blockiness > 1.3 || (isJpegFile && blockiness > 1.18 && noise > 2)) {
    route = "jpeg";
    reasons.push(`blocs 8×8 marqués (indice ${blockiness.toFixed(2)})`);
  } else if (noise > 5) {
    route = "noisy";
    reasons.push(`bruit élevé (σ ≈ ${noise.toFixed(1)})`);
  } else if (blurIndex < 0.9 && gradient > 1) {
    route = "blurry";
    reasons.push(`netteté faible pour le contenu (indice ${blurIndex.toFixed(2)})`);
  } else if (requestedScale >= 1.35) {
    route = "clean-small";
    reasons.push(`image propre, agrandissement ×${requestedScale.toFixed(2)} demandé`);
  } else {
    route = "clean";
    reasons.push("image propre, agrandissement faible : l'IA n'apporterait rien de mesurable");
  }

  if (tonal.clippedHighlights > 0.02) reasons.push(`${(tonal.clippedHighlights * 100).toFixed(1)} % de hautes lumières brûlées (non récupérables)`);
  if (tonal.clippedShadows > 0.02) reasons.push(`${(tonal.clippedShadows * 100).toFixed(1)} % d'ombres bouchées`);

  return {
    width,
    height,
    megapixels,
    noise,
    sharpness,
    gradient,
    blockiness,
    ...tonal,
    isJpegFile,
    route,
    reasons,
  };
}

/**
 * Règles de routage. Restormer et GFPGAN arriveront aux incréments suivants ;
 * en attendant, les routes « bruit/flou/ancien » s'appuient sur les modèles
 * entraînés sur des dégradations réelles (Swin2SR BSRGAN, Real-ESRGAN).
 */
export function planForRoute(diagnosis: ImageDiagnosis, lowMemory: boolean): RoutePlan {
  const pick = (ids: RestorationModelId[], heavyFallback: RestorationModelId): RestorationModelId[] =>
    lowMemory ? ids.map((id) => (id === "realesrgan-x4plus" ? heavyFallback : id)) : ids;

  switch (diagnosis.route) {
    case "clean-small":
      return {
        route: diagnosis.route,
        label: "Image nette mais petite",
        models: ["realesrgan-general-x4v3", "swin2sr-classical-x4"],
        finishSharpen: 0.15,
      };
    case "noisy":
      return {
        route: diagnosis.route,
        label: "Image bruitée",
        models: pick(["swin2sr-realworld-x4", "realesrgan-x4plus"], "realesrgan-general-x4v3"),
        finishSharpen: 0,
      };
    case "blurry":
      return {
        route: diagnosis.route,
        label: "Photo légèrement floue",
        models: pick(["swin2sr-realworld-x4", "realesrgan-x4plus"], "realesrgan-general-x4v3"),
        finishSharpen: 0.35,
      };
    case "jpeg":
      return {
        route: diagnosis.route,
        label: "JPEG très compressé",
        models: ["swin2sr-compressed-x4", "realesrgan-general-x4v3"],
        finishSharpen: 0,
      };
    case "old-photo":
      return {
        route: diagnosis.route,
        label: "Photo ancienne",
        models: pick(["swin2sr-realworld-x4", "realesrgan-x4plus"], "realesrgan-general-x4v3"),
        finishSharpen: 0.1,
      };
    default:
      return { route: "clean", label: "Image propre", models: [], finishSharpen: 0.2 };
  }
}
