export interface DeepFocusSettings {
  enabled: boolean;
  /** Nombre de bandes de focalisation. UltraVision impose un minimum de 10. */
  layers: number;
  /** Intensité 0..1. */
  strength: number;
}

export interface DeepFocusReport {
  applied: boolean;
  layers: number;
  confidence: number;
  skippedReason?: string;
}

export const DEFAULT_DEEP_FOCUS: DeepFocusSettings = {
  enabled: true,
  layers: 10,
  strength: 0.58,
};

export const MIN_DEEP_FOCUS_LAYERS = 10;
export const MAX_DEEP_FOCUS_LAYERS = 24;

/**
 * Le moteur reste volontairement sous 10 MP pour ne pas dupliquer des dizaines
 * de mégaoctets dans la RAM d'un téléphone. Au-delà, UltraVision continue le
 * pipeline normal sans provoquer de crash.
 */
export const DEEP_FOCUS_MAX_PIXELS = 10_000_000;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clamp255(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function sanitizeSettings(settings: DeepFocusSettings): DeepFocusSettings {
  return {
    enabled: Boolean(settings.enabled),
    layers: Math.round(clamp(settings.layers, MIN_DEEP_FOCUS_LAYERS, MAX_DEEP_FOCUS_LAYERS)),
    strength: clamp(settings.strength, 0, 1),
  };
}

function lumaAt(data: Uint8ClampedArray, pixelIndex: number): number {
  const i = pixelIndex * 4;
  return data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
}

function gradientAt(data: Uint8ClampedArray, width: number, x: number, y: number): number {
  const i = y * width + x;
  const left = lumaAt(data, i - 1);
  const right = lumaAt(data, i + 1);
  const up = lumaAt(data, i - width);
  const down = lumaAt(data, i + width);
  return (Math.abs(right - left) + Math.abs(down - up)) * 0.5;
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.round((sorted.length - 1) * clamp(ratio, 0, 1));
  return sorted[index] ?? 0;
}

interface FocusThresholds {
  low: number;
  high: number;
  confidence: number;
}

function focusThresholds(data: Uint8ClampedArray, width: number, height: number): FocusThresholds {
  const samples: number[] = [];
  const stride = Math.max(2, Math.floor(Math.max(width, height) / 320));

  for (let y = 1; y < height - 1; y += stride) {
    for (let x = 1; x < width - 1; x += stride) {
      samples.push(gradientAt(data, width, x, y));
    }
  }

  samples.sort((a, b) => a - b);
  const low = percentile(samples, 0.25);
  const high = Math.max(low + 4, percentile(samples, 0.92));
  const range = high - low;
  const useful = samples.filter((value) => value > low + range * 0.15).length;
  const confidence = samples.length ? clamp((useful / samples.length) * clamp(range / 30, 0.25, 1), 0, 1) : 0;

  return { low, high, confidence };
}

/**
 * Transforme une énergie de contour en bande de focalisation.
 * 0 = zone déjà nette, layers-1 = zone la plus déficitaire en micro-contraste.
 *
 * Important : ce n'est pas une mesure métrique de profondeur physique. Sur une
 * image unique, la profondeur optique perdue n'est pas directement observable.
 * C'est une estimation de déficit de focalisation destinée à piloter la
 * restauration locale.
 */
export function focusBandForGradient(
  gradient: number,
  low: number,
  high: number,
  layers: number,
): number {
  const safeLayers = Math.round(clamp(layers, MIN_DEEP_FOCUS_LAYERS, MAX_DEEP_FOCUS_LAYERS));
  const sharpness = clamp((gradient - low) / Math.max(1, high - low), 0, 1);
  const deficit = 1 - sharpness;
  return Math.round(deficit * (safeLayers - 1));
}

/**
 * Crée une carte de focalisation lisible dans l'interface.
 * Clair = zone demandant davantage de restauration, sombre = zone déjà nette.
 */
export function createFocusMapCanvas(source: HTMLCanvasElement, layers: number): HTMLCanvasElement {
  const safeLayers = Math.round(clamp(layers, MIN_DEEP_FOCUS_LAYERS, MAX_DEEP_FOCUS_LAYERS));
  const ctx = source.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas 2D indisponible pour la carte Deep Focus.");

  const image = ctx.getImageData(0, 0, source.width, source.height);
  const src = image.data;
  const thresholds = focusThresholds(src, source.width, source.height);

  const map = document.createElement("canvas");
  map.width = source.width;
  map.height = source.height;
  const mapCtx = map.getContext("2d");
  if (!mapCtx) throw new Error("Canvas 2D indisponible pour la carte Deep Focus.");

  const output = mapCtx.createImageData(map.width, map.height);
  const dst = output.data;

  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const pixel = y * source.width + x;
      const target = pixel * 4;

      if (x === 0 || y === 0 || x === source.width - 1 || y === source.height - 1) {
        dst[target] = 0;
        dst[target + 1] = 0;
        dst[target + 2] = 0;
        dst[target + 3] = 255;
        continue;
      }

      const gradient = gradientAt(src, source.width, x, y);
      const band = focusBandForGradient(gradient, thresholds.low, thresholds.high, safeLayers);
      const t = band / Math.max(1, safeLayers - 1);

      // Palette perceptuelle simple : bleu/cyan pour les zones déjà nettes,
      // jaune/rouge pour les zones où la restauration est la plus sollicitée.
      const r = clamp255(40 + 215 * t);
      const g = clamp255(190 - 70 * Math.abs(t - 0.55) - 80 * t);
      const b = clamp255(230 - 190 * t);

      dst[target] = r;
      dst[target + 1] = g;
      dst[target + 2] = b;
      dst[target + 3] = 255;
    }
  }

  mapCtx.putImageData(output, 0, 0);
  return map;
}

/**
 * UltraVision Deep Focus 10+.
 *
 * Le traitement construit au moins dix bandes de déficit de focalisation et
 * applique une déconvolution locale limitée par contraste. Il ne prétend pas
 * récupérer une profondeur physique disparue : il rend simultanément plus
 * lisibles plusieurs zones de netteté d'une image 2D tout en limitant halos et
 * amplification du bruit.
 */
export async function applyDeepFocus(
  canvas: HTMLCanvasElement,
  settings: DeepFocusSettings,
  onProgress?: (ratio: number, label: string) => void,
): Promise<DeepFocusReport> {
  const safe = sanitizeSettings(settings);
  if (!safe.enabled || safe.strength <= 0) {
    return { applied: false, layers: safe.layers, confidence: 0, skippedReason: "Deep Focus désactivé." };
  }

  const pixels = canvas.width * canvas.height;
  if (pixels > DEEP_FOCUS_MAX_PIXELS) {
    return {
      applied: false,
      layers: safe.layers,
      confidence: 0,
      skippedReason: `Deep Focus ignoré au-delà de ${(DEEP_FOCUS_MAX_PIXELS / 1_000_000).toFixed(0)} MP pour préserver la mémoire locale.`,
    };
  }

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    return { applied: false, layers: safe.layers, confidence: 0, skippedReason: "Canvas 2D indisponible." };
  }

  onProgress?.(0.04, "Deep Focus · analyse des micro-contrastes");
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const src = new Uint8ClampedArray(image.data);
  const dst = image.data;
  const thresholds = focusThresholds(src, canvas.width, canvas.height);

  const width = canvas.width;
  const height = canvas.height;
  const maxCorrection = 8 + safe.strength * 22;
  const layerDenominator = Math.max(1, safe.layers - 1);

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const pixel = y * width + x;
      const center = pixel * 4;
      const left = center - 4;
      const right = center + 4;
      const up = center - width * 4;
      const down = center + width * 4;

      const gradient = gradientAt(src, width, x, y);
      const band = focusBandForGradient(gradient, thresholds.low, thresholds.high, safe.layers);
      const deficit = band / layerDenominator;

      // Les zones moins nettes reçoivent davantage de correction, mais la
      // correction reste contrast-limited afin d'éviter halos et faux détails.
      const amount = safe.strength * (0.12 + deficit * 0.38);
      const gate = clamp(gradient / Math.max(8, thresholds.high), 0.18, 1);
      const effective = amount * gate;

      for (let channel = 0; channel < 3; channel += 1) {
        const c = src[center + channel];
        const laplacian =
          c * 4 -
          src[left + channel] -
          src[right + channel] -
          src[up + channel] -
          src[down + channel];

        const correction = clamp(laplacian * effective, -maxCorrection, maxCorrection);
        dst[center + channel] = clamp255(c + correction);
      }
      dst[center + 3] = src[center + 3];
    }

    if (y % 96 === 0) {
      const ratio = y / Math.max(1, height - 1);
      onProgress?.(0.08 + ratio * 0.86, `Deep Focus · ${safe.layers} plans · ${Math.round(ratio * 100)} %`);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  }

  ctx.putImageData(image, 0, 0);
  onProgress?.(1, `Deep Focus ${safe.layers}+ · terminé`);

  return {
    applied: true,
    layers: safe.layers,
    confidence: thresholds.confidence,
  };
}
