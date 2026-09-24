import { throwIfCancelled } from "./cancellation";
import { decodeImageFile } from "./imageDecode";

export interface EvidenceFusionReport {
  applied: boolean;
  meanAiDetailWeight: number;
  cycleConfidence: number;
  cycleMeanAbsoluteError: number;
  rejectedDetailPercent: number;
  bands: number;
  elapsedMs: number;
  cycleMs: number;
  fusionMs: number;
  estimatedPeakWorkingMb: number;
  bandRows: number;
  performanceAbort: boolean;
  qualityGate: "not-run" | "accepted" | "reverted";
  qualityDelta: number | null;
  skippedReason?: string;
}

export interface EvidenceFusionOptions {
  format: string;
  /** Dimensions source connues : permettent un preflight mémoire sans décoder. */
  sourceSize?: { width: number; height: number };
  onProgress?: (ratio: number, label: string) => void;
}

const PROBE_MAX_SIDE = 512;
const HALO = 2;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clamp255(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function lumaAt(
  data: Uint8ClampedArray,
  pixel: number,
): number {
  const i = pixel * 4;
  return (
    data[i] * 0.2126 +
    data[i + 1] * 0.7152 +
    data[i + 2] * 0.0722
  );
}

interface FusionRuntimeBudget {
  maxPixels: number;
  bandRows: number;
  maxWorkingMb: number;
  maxFusionMs: number;
  mobile: boolean;
  label: string;
}

function runtimeBudget(width: number): FusionRuntimeBudget {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const memory =
    typeof nav.deviceMemory === "number"
      ? nav.deviceMemory
      : null;
  const mobile = /Android|iPhone|iPad|iPod/i.test(
    navigator.userAgent,
  );
  const lowMemory = memory !== null && memory <= 4;

  // Les plafonds sont volontairement plus prudents que les limites canvas :
  // Evidence Fusion coexiste avec un master décodé, l'original, le canvas
  // final et plusieurs buffers de bande.
  const maxPixels = mobile
    ? lowMemory
      ? 4_500_000
      : 7_500_000
    : lowMemory
      ? 10_000_000
      : 22_000_000;
  const maxWorkingMb = mobile
    ? lowMemory
      ? 150
      : 230
    : lowMemory
      ? 420
      : 900;
  const maxFusionMs = mobile
    ? lowMemory
      ? 9_000
      : 15_000
    : 35_000;

  const tempBytes = mobile
    ? lowMemory
      ? 10 * 1024 * 1024
      : 14 * 1024 * 1024
    : 38 * 1024 * 1024;
  const bytesPerPixelEstimate = 22;
  const rowsByMemory = Math.floor(
    tempBytes /
      Math.max(1, width * bytesPerPixelEstimate),
  );

  return {
    maxPixels,
    maxWorkingMb,
    maxFusionMs,
    mobile,
    bandRows: Math.max(
      24,
      Math.min(
        mobile ? (lowMemory ? 56 : 80) : 176,
        rowsByMemory,
      ),
    ),
    label: mobile
      ? `mobile ${memory ?? "RAM ?"} Go`
      : `desktop ${memory ?? "RAM ?"} Go`,
  };
}

function estimatedPeakWorkingMb(
  outputPixels: number,
  sourcePixels: number,
  width: number,
  bandRows: number,
): number {
  // Surfaces décodées source + master + canvas de sortie, puis deux bandes
  // RGBA, deux lumas Float32 et la bande de sortie. Le coefficient 1.18 garde
  // une marge pour les objets JS et les allocations internes Canvas.
  const fullBytes =
    sourcePixels * 4 +
    outputPixels * 4 +
    outputPixels * 4;
  const bandPixels = width * (bandRows + HALO * 2);
  const bandBytes = bandPixels * 22;
  return ((fullBytes + bandBytes) * 1.18) / (1024 * 1024);
}

function makeCanvas(
  width: number,
  height: number,
  readable = false,
): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const ctx = canvas.getContext(
    "2d",
    readable ? { willReadFrequently: true } : undefined,
  );
  if (!ctx) throw new Error("Canvas 2D indisponible pour Evidence Fusion.");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  return { canvas, ctx };
}

function drawMappedBand(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  outputWidth: number,
  outputHeight: number,
  top: number,
  bandHeight: number,
): HTMLCanvasElement {
  const { canvas, ctx } = makeCanvas(
    outputWidth,
    bandHeight,
    true,
  );
  const sy = (top / outputHeight) * sourceHeight;
  const sh = (bandHeight / outputHeight) * sourceHeight;
  ctx.drawImage(
    source,
    0,
    sy,
    sourceWidth,
    sh,
    0,
    0,
    outputWidth,
    bandHeight,
  );
  return canvas;
}

function buildLuma(
  data: Uint8ClampedArray,
): Float32Array {
  const out = new Float32Array(data.length / 4);
  for (let p = 0; p < out.length; p += 1) {
    out[p] = lumaAt(data, p);
  }
  return out;
}

function localNear(
  values: Float32Array,
  width: number,
  p: number,
): number {
  return (
    values[p] * 4 +
    values[p - 1] +
    values[p + 1] +
    values[p - width] +
    values[p + width]
  ) / 8;
}

function localFar(
  values: Float32Array,
  width: number,
  p: number,
): number {
  return (
    values[p] * 4 +
    values[p - 2] +
    values[p + 2] +
    values[p - width * 2] +
    values[p + width * 2]
  ) / 8;
}

interface CycleMap {
  width: number;
  height: number;
  confidence: Float32Array;
  meanConfidence: number;
  meanAbsoluteError: number;
}

function smoothMap(
  values: Float32Array,
  width: number,
  height: number,
): Float32Array {
  const out = new Float32Array(values.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        const yy = Math.min(
          height - 1,
          Math.max(0, y + dy),
        );
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = Math.min(
            width - 1,
            Math.max(0, x + dx),
          );
          sum += values[yy * width + xx];
          count += 1;
        }
      }
      out[y * width + x] = sum / count;
    }
  }
  return out;
}

async function buildCycleMap(
  faithfulSource: CanvasImageSource,
  faithfulWidth: number,
  faithfulHeight: number,
  masterSource: CanvasImageSource,
  masterWidth: number,
  masterHeight: number,
): Promise<CycleMap> {
  const scale = Math.min(
    1,
    PROBE_MAX_SIDE /
      Math.max(faithfulWidth, faithfulHeight),
  );
  const width = Math.max(
    48,
    Math.round(faithfulWidth * scale),
  );
  const height = Math.max(
    48,
    Math.round(faithfulHeight * scale),
  );

  const sourceProbe = makeCanvas(width, height, true);
  const masterProbe = makeCanvas(width, height, true);
  sourceProbe.ctx.drawImage(
    faithfulSource,
    0,
    0,
    faithfulWidth,
    faithfulHeight,
    0,
    0,
    width,
    height,
  );
  masterProbe.ctx.drawImage(
    masterSource,
    0,
    0,
    masterWidth,
    masterHeight,
    0,
    0,
    width,
    height,
  );

  const sourceData = sourceProbe.ctx.getImageData(
    0,
    0,
    width,
    height,
  ).data;
  const masterData = masterProbe.ctx.getImageData(
    0,
    0,
    width,
    height,
  ).data;
  const sourceY = buildLuma(sourceData);
  const masterY = buildLuma(masterData);
  const confidence = new Float32Array(width * height);

  let confidenceSum = 0;
  let absoluteError = 0;
  for (let y = 0; y < height; y += 1) {
    const ym = Math.max(0, y - 1);
    const yp = Math.min(height - 1, y + 1);
    for (let x = 0; x < width; x += 1) {
      const xm = Math.max(0, x - 1);
      const xp = Math.min(width - 1, x + 1);
      const p = y * width + x;
      const gradient =
        (
          Math.abs(
            sourceY[y * width + xp] -
              sourceY[y * width + xm],
          ) +
          Math.abs(
            sourceY[yp * width + x] -
              sourceY[ym * width + x],
          )
        ) *
        0.5;
      const error = Math.abs(masterY[p] - sourceY[p]);
      absoluteError += error;

      // Une reconstruction peut s'écarter davantage sur une vraie arête que
      // dans un aplat. Les écarts dans les zones plates sont donc sanctionnés
      // beaucoup plus tôt.
      const tolerance = 8 + gradient * 0.75;
      const localConfidence = clamp(
        1 - error / Math.max(12, tolerance + 16),
        0,
        1,
      );
      confidence[p] = localConfidence;
      confidenceSum += localConfidence;
    }
  }

  sourceProbe.canvas.width = sourceProbe.canvas.height = 1;
  masterProbe.canvas.width = masterProbe.canvas.height = 1;

  const smooth = smoothMap(confidence, width, height);
  let smoothSum = 0;
  for (let i = 0; i < smooth.length; i += 1) {
    smoothSum += smooth[i];
  }

  return {
    width,
    height,
    confidence: smooth,
    meanConfidence:
      smoothSum / Math.max(1, smooth.length),
    meanAbsoluteError:
      absoluteError / Math.max(1, confidence.length),
  };
}

function sampleCycle(
  cycle: CycleMap,
  x: number,
  y: number,
  width: number,
  height: number,
): number {
  const cx = Math.min(
    cycle.width - 1,
    Math.max(
      0,
      Math.round(
        (x / Math.max(1, width - 1)) *
          (cycle.width - 1),
      ),
    ),
  );
  const cy = Math.min(
    cycle.height - 1,
    Math.max(
      0,
      Math.round(
        (y / Math.max(1, height - 1)) *
          (cycle.height - 1),
      ),
    ),
  );
  return cycle.confidence[cy * cycle.width + cx];
}

function encodeType(format: string): string {
  return format === "image/jpeg" ||
    format === "image/webp"
    ? format
    : "image/png";
}

async function canvasToBlob(
  canvas: HTMLCanvasElement,
  format: string,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(
              new Error(
                "Encodage Evidence Fusion impossible.",
              ),
            ),
      encodeType(format),
      0.96,
    );
  });
}

/**
 * Fusion perceptuelle mémoire-bornée.
 *
 * Fréquences :
 * - basse : toujours issue de l'original fidèle (couleur/exposition) ;
 * - moyenne : mélange prudent original/IA ;
 * - haute : IA seulement lorsque structure + cycle consistency l'autorisent.
 *
 * Le cycle est calculé en reprojetant le master à la géométrie de la source.
 * Ce n'est pas une vérité terrain, mais un garde-fou utile contre les détails
 * qui s'écartent fortement du signal réellement observé.
 */
export async function fuseMasterWithEvidence(
  original: Blob,
  master: Blob,
  outputSize: { width: number; height: number },
  options: EvidenceFusionOptions,
): Promise<{
  blob: Blob;
  report: EvidenceFusionReport;
}> {
  const startedAt = performance.now();
  const pixels = outputSize.width * outputSize.height;
  const budget = runtimeBudget(outputSize.width);
  const preflightSourcePixels = options.sourceSize
    ? options.sourceSize.width * options.sourceSize.height
    : pixels;
  const preflightPeakMb = estimatedPeakWorkingMb(
    pixels,
    preflightSourcePixels,
    outputSize.width,
    budget.bandRows,
  );

  const skipped = (
    reason: string,
    peakMb = preflightPeakMb,
  ): {
    blob: Blob;
    report: EvidenceFusionReport;
  } => ({
    blob: master,
    report: {
      applied: false,
      meanAiDetailWeight: 0,
      cycleConfidence: 0,
      cycleMeanAbsoluteError: 0,
      rejectedDetailPercent: 0,
      bands: 0,
      elapsedMs: performance.now() - startedAt,
      cycleMs: 0,
      fusionMs: 0,
      estimatedPeakWorkingMb: peakMb,
      bandRows: budget.bandRows,
      performanceAbort: false,
      qualityGate: "not-run",
      qualityDelta: null,
      skippedReason: reason,
    },
  });

  if (pixels > budget.maxPixels) {
    return skipped(
      `Evidence Fusion ignorée à ${(pixels / 1_000_000).toFixed(1)} MP : budget sûr ${(budget.maxPixels / 1_000_000).toFixed(1)} MP (${budget.label}).`,
    );
  }
  if (preflightPeakMb > budget.maxWorkingMb) {
    return skipped(
      `Evidence Fusion ignorée avant décodage : pic mémoire estimé ${preflightPeakMb.toFixed(0)} Mo > budget ${budget.maxWorkingMb} Mo (${budget.label}).`,
    );
  }

  const [source, ai] = await Promise.all([
    decodeImageFile(original),
    decodeImageFile(master),
  ]);

  const actualPeakMb = estimatedPeakWorkingMb(
    pixels,
    source.width * source.height,
    outputSize.width,
    budget.bandRows,
  );
  if (actualPeakMb > budget.maxWorkingMb) {
    source.close();
    ai.close();
    return skipped(
      `Evidence Fusion ignorée après lecture des dimensions : pic mémoire estimé ${actualPeakMb.toFixed(0)} Mo > budget ${budget.maxWorkingMb} Mo.`,
      actualPeakMb,
    );
  }

  const output = makeCanvas(
    outputSize.width,
    outputSize.height,
  );
  let meanWeight = 0;
  let weightedPixels = 0;
  let rejected = 0;
  let bands = 0;

  try {
    options.onProgress?.(
      0.03,
      "Evidence Fusion · cycle consistency",
    );
    const cycleStartedAt = performance.now();
    const cycle = await buildCycleMap(
      source.source,
      source.width,
      source.height,
      ai.source,
      ai.width,
      ai.height,
    );
    const cycleMs = performance.now() - cycleStartedAt;
    const fusionStartedAt = performance.now();
    let measuredBandMs = 0;

    // Si le master ne ressemble déjà plus suffisamment à la source une fois
    // reprojeté, la fusion devient très conservatrice automatiquement.
    const globalCycleGate = clamp(
      (cycle.meanConfidence - 0.34) / 0.48,
      0.08,
      1,
    );

    for (
      let y0 = 0;
      y0 < outputSize.height;
      y0 += budget.bandRows
    ) {
      throwIfCancelled();
      const bandStartedAt = performance.now();
      const writeStart = y0;
      const writeEnd = Math.min(
        outputSize.height,
        y0 + budget.bandRows,
      );
      const readStart = Math.max(0, writeStart - HALO);
      const readEnd = Math.min(
        outputSize.height,
        writeEnd + HALO,
      );
      const readHeight = readEnd - readStart;

      const faithfulBand = drawMappedBand(
        source.source,
        source.width,
        source.height,
        outputSize.width,
        outputSize.height,
        readStart,
        readHeight,
      );
      const aiBand = drawMappedBand(
        ai.source,
        ai.width,
        ai.height,
        outputSize.width,
        outputSize.height,
        readStart,
        readHeight,
      );

      const faithfulCtx = faithfulBand.getContext(
        "2d",
        { willReadFrequently: true },
      );
      const aiCtx = aiBand.getContext(
        "2d",
        { willReadFrequently: true },
      );
      if (!faithfulCtx || !aiCtx) {
        throw new Error(
          "Bandes Evidence Fusion indisponibles.",
        );
      }

      const faithfulImage = faithfulCtx.getImageData(
        0,
        0,
        outputSize.width,
        readHeight,
      );
      const aiImage = aiCtx.getImageData(
        0,
        0,
        outputSize.width,
        readHeight,
      );
      const faithful = faithfulImage.data;
      const aiPixels = aiImage.data;
      const faithfulY = buildLuma(faithful);
      const aiY = buildLuma(aiPixels);

      const localStart = writeStart - readStart;
      const localEnd = writeEnd - readStart;
      const outHeight = localEnd - localStart;
      const outputImage = output.ctx.createImageData(
        outputSize.width,
        outHeight,
      );
      const dst = outputImage.data;

      for (
        let localY = localStart;
        localY < localEnd;
        localY += 1
      ) {
        if ((localY - localStart) % 24 === 0) {
          throwIfCancelled();
        }
        const globalY = readStart + localY;
        for (
          let x = 0;
          x < outputSize.width;
          x += 1
        ) {
          const dstPixel =
            (localY - localStart) *
              outputSize.width +
            x;
          const dstIndex = dstPixel * 4;
          const p = localY * outputSize.width + x;
          const srcIndex = p * 4;

          // Aux bords, le détail fréquentiel manque de voisins : original
          // fidèle, ce qui évite toute couture artificielle.
          if (
            x < HALO ||
            x >= outputSize.width - HALO ||
            globalY < HALO ||
            globalY >= outputSize.height - HALO
          ) {
            dst[dstIndex] = faithful[srcIndex];
            dst[dstIndex + 1] =
              faithful[srcIndex + 1];
            dst[dstIndex + 2] =
              faithful[srcIndex + 2];
            dst[dstIndex + 3] =
              faithful[srcIndex + 3];
            continue;
          }

          const srcNear = localNear(
            faithfulY,
            outputSize.width,
            p,
          );
          const aiNear = localNear(
            aiY,
            outputSize.width,
            p,
          );
          const srcFar = localFar(
            faithfulY,
            outputSize.width,
            p,
          );
          const aiFar = localFar(
            aiY,
            outputSize.width,
            p,
          );

          const srcHigh = faithfulY[p] - srcNear;
          const aiHigh = aiY[p] - aiNear;
          const srcMid = srcNear - srcFar;
          const aiMid = aiNear - aiFar;

          const gradient =
            (
              Math.abs(
                faithfulY[p + 1] -
                  faithfulY[p - 1],
              ) +
              Math.abs(
                faithfulY[
                  p + outputSize.width
                ] -
                  faithfulY[
                    p - outputSize.width
                  ],
              )
            ) *
            0.5;
          const structure = clamp(
            (gradient - 1.2) / 18,
            0,
            1,
          );
          const cycleConfidence = sampleCycle(
            cycle,
            x,
            globalY,
            outputSize.width,
            outputSize.height,
          );
          const directDifference = Math.abs(
            aiY[p] - faithfulY[p],
          );
          const disagreementGuard = clamp(
            1 -
              Math.max(
                0,
                directDifference -
                  (5 + gradient * 0.45),
              ) /
                34,
            0,
            1,
          );
          const signAgreement =
            Math.abs(srcHigh) < 0.8 ||
            srcHigh * aiHigh >= 0
              ? 1
              : 0.32;
          const excessDetail =
            Math.abs(aiHigh) >
            Math.abs(srcHigh) * 3.2 + 9;
          const hallucinationGuard = excessDetail
            ? 0.35
            : 1;

          const detailWeight = clamp(
            (
              0.04 +
              structure * 0.96
            ) *
              cycleConfidence *
              globalCycleGate *
              disagreementGuard *
              signAgreement *
              hallucinationGuard,
            0,
            0.94,
          );
          const midWeight = detailWeight * 0.46;

          if (detailWeight < 0.12) rejected += 1;
          meanWeight += detailWeight;
          weightedPixels += 1;

          // Basse fréquence et chrominance restent ancrées sur la source.
          // L'IA n'apporte que ce que l'Evidence Gate local autorise.
          const fusedY =
            srcFar +
            srcMid * (1 - midWeight) +
            aiMid * midWeight +
            srcHigh * (1 - detailWeight) +
            aiHigh * detailWeight;
          const luminanceDelta =
            fusedY - faithfulY[p];

          // Petite contribution chromatique de l'IA uniquement dans les
          // régions très fiables, après retrait de sa dérive de luminance.
          const chromaWeight =
            Math.min(0.14, detailWeight * 0.14);
          const aiLumaDelta =
            aiY[p] - faithfulY[p];

          for (let channel = 0; channel < 3; channel += 1) {
            const faithfulChannel =
              faithful[srcIndex + channel];
            const aiChromaDelta =
              aiPixels[srcIndex + channel] -
              faithfulChannel -
              aiLumaDelta;
            dst[dstIndex + channel] = clamp255(
              faithfulChannel +
                luminanceDelta +
                aiChromaDelta * chromaWeight,
            );
          }
          dst[dstIndex + 3] =
            faithful[srcIndex + 3];
        }
      }

      output.ctx.putImageData(
        outputImage,
        0,
        writeStart,
      );
      faithfulBand.width = faithfulBand.height = 1;
      aiBand.width = aiBand.height = 1;
      bands += 1;
      measuredBandMs += performance.now() - bandStartedAt;

      const ratio =
        writeEnd / Math.max(1, outputSize.height);
      const remainingBands = Math.max(
        0,
        Math.ceil(
          (outputSize.height - writeEnd) /
            budget.bandRows,
        ),
      );
      const meanBandMs =
        measuredBandMs / Math.max(1, bands);
      const projectedFusionMs =
        measuredBandMs +
        remainingBands * meanBandMs;

      // Watchdog de performance : après deux bandes réelles, si le téléphone
      // indique que la passe complète serait trop longue, on rend le master
      // précédent plutôt que de monopoliser le thread principal.
      if (
        bands >= 2 &&
        projectedFusionMs > budget.maxFusionMs
      ) {
        return {
          blob: master,
          report: {
            applied: false,
            meanAiDetailWeight: 0,
            cycleConfidence: cycle.meanConfidence,
            cycleMeanAbsoluteError: cycle.meanAbsoluteError,
            rejectedDetailPercent: 0,
            bands,
            elapsedMs: performance.now() - startedAt,
            cycleMs,
            fusionMs: performance.now() - fusionStartedAt,
            estimatedPeakWorkingMb: actualPeakMb,
            bandRows: budget.bandRows,
            performanceAbort: true,
            qualityGate: "not-run",
            qualityDelta: null,
            skippedReason:
              `Evidence Fusion interrompue proprement : temps projeté ${(projectedFusionMs / 1000).toFixed(1)} s > budget ${(budget.maxFusionMs / 1000).toFixed(0)} s (${budget.label}).`,
          },
        };
      }

      options.onProgress?.(
        0.12 + ratio * 0.84,
        `Evidence Fusion · bande ${bands} · ${Math.round(ratio * 100)} % · ~${Math.round(meanBandMs)} ms/bande`,
      );
      await new Promise<void>((resolve) =>
        window.setTimeout(resolve, 0),
      );
    }

    const blob = await canvasToBlob(
      output.canvas,
      options.format,
    );
    const denominator = Math.max(1, weightedPixels);
    return {
      blob,
      report: {
        applied: true,
        meanAiDetailWeight:
          meanWeight / denominator,
        cycleConfidence: cycle.meanConfidence,
        cycleMeanAbsoluteError:
          cycle.meanAbsoluteError,
        rejectedDetailPercent:
          (rejected / denominator) * 100,
        bands,
        elapsedMs: performance.now() - startedAt,
        cycleMs,
        fusionMs: performance.now() - fusionStartedAt,
        estimatedPeakWorkingMb: actualPeakMb,
        bandRows: budget.bandRows,
        performanceAbort: false,
        qualityGate: "not-run",
        qualityDelta: null,
      },
    };
  } finally {
    source.close();
    ai.close();
    output.canvas.width = output.canvas.height = 1;
  }
}
