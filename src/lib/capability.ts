/**
 * Sondes réelles des capacités canvas du navigateur.
 *
 * Objectif : ne plus "promettre" une définition en se basant uniquement sur
 * navigator.deviceMemory. La dimension maximale est réellement mesurée, et
 * l'allocation finale est réellement testée juste avant le traitement.
 */

export interface CanvasLimits {
  /** Côté maximal réellement supporté (mesuré). */
  maxDimension: number;
  /** Budget de pixels estimé (heuristique mémoire, pas une mesure). */
  estimatedPixelBudget: number;
  /** true si maxDimension provient d'une mesure et non d'une valeur par défaut. */
  measured: boolean;
}

let cached: CanvasLimits | null = null;

/**
 * Test réel : on alloue le canvas, on écrit un pixel dans le coin le plus
 * éloigné et on le relit. Un navigateur qui clampe ou abandonne l'allocation
 * échoue ici au lieu de produire silencieusement une image noire.
 */
export function canAllocateCanvas(width: number, height: number): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return false;

  let canvas: HTMLCanvasElement | null = null;
  try {
    canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    if (canvas.width !== width || canvas.height !== height) return false;

    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return false;

    ctx.fillStyle = "#ff0000";
    ctx.fillRect(width - 1, height - 1, 1, 1);
    const probe = ctx.getImageData(width - 1, height - 1, 1, 1).data;
    return probe[0] > 200 && probe[1] < 60 && probe[2] < 60 && probe[3] > 200;
  } catch {
    return false;
  } finally {
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
    }
  }
}

/**
 * Mesure du côté maximal. Peu coûteux : les canvas de test sont hauts de 4 px,
 * donc aucune allocation massive n'est faite pendant la mesure.
 */
function measureMaxDimension(): { value: number; measured: boolean } {
  const candidates = [4_096, 8_192, 11_264, 16_384, 22_528, 32_767];
  let best = 0;

  for (const candidate of candidates) {
    if (canAllocateCanvas(candidate, 4)) best = candidate;
    else break;
  }

  if (best === 0) return { value: 4_096, measured: false };
  return { value: best, measured: true };
}

/**
 * Budget mémoire. Assumé comme heuristique : navigator.deviceMemory est
 * arrondi et absent sur Safari/Firefox. L'allocation réelle reste testée
 * par canAllocateCanvas() avant chaque traitement.
 */
function estimatePixelBudget(): number {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const memory = nav.deviceMemory;
  const cores = nav.hardwareConcurrency ?? 4;
  const mobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent);

  if (mobile) return memory && memory >= 6 ? 48_000_000 : 28_000_000;
  if (memory == null) return cores >= 8 ? 150_000_000 : 90_000_000;
  if (memory <= 4) return 60_000_000;
  if (memory <= 8) return 120_000_000;
  return 190_000_000;
}

export function canvasLimits(): CanvasLimits {
  if (cached) return cached;
  const dimension = measureMaxDimension();
  cached = {
    maxDimension: dimension.value,
    estimatedPixelBudget: estimatePixelBudget(),
    measured: dimension.measured,
  };
  return cached;
}

export function resetCanvasLimitsCache(): void {
  cached = null;
}
