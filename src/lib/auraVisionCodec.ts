import { decodeImageFile } from "./imageDecode";
import { loadedModel, upscaleWithAi } from "./aiUpscaler";
import { applyFinalAdaptiveSharpen } from "./finalSharpen";

const MAGIC = [0x41, 0x56, 0x31, 0x58]; // AV1X
const HEADER_BYTES = 48;
const VERSION = 1;
const GRID_W = 16;
const GRID_H = 12;
const MAX_ENCODE_PIXELS = 12_000_000;

enum SemanticClass {
  Flat = 0,
  Sky = 1,
  Skin = 2,
  Geometry = 3,
  Texture = 4,
}

export interface AuraVisionEncodeResult {
  blob: Blob;
  width: number;
  height: number;
  baseWidth: number;
  baseHeight: number;
  baseBytes: number;
  semanticBytes: number;
  latentBytes: number;
  ratioVsRgba: number;
  semanticSummary: string;
}

export interface AuraVisionDecodeResult {
  blob: Blob;
  width: number;
  height: number;
  usedAi: boolean;
  structuralSsim: number | null;
  fallbackReason?: string;
  semanticSummary: string;
}

export interface AuraVisionDecodeOptions {
  upscaleFactor?: 1 | 2;
  useAi?: boolean;
  structuralThreshold?: number;
  onProgress?: (ratio: number, label: string) => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("Encodage Canvas impossible.")),
      type,
      quality,
    );
  });
}

function semanticName(value: number): string {
  switch (value) {
    case SemanticClass.Sky: return "ciel";
    case SemanticClass.Skin: return "peau";
    case SemanticClass.Geometry: return "texte/structure";
    case SemanticClass.Texture: return "texture";
    default: return "aplat";
  }
}

function semanticSummary(map: Uint8Array): string {
  const counts = new Map<number, number>();
  for (const value of map) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => `${semanticName(value)} ${Math.round(count / Math.max(1, map.length) * 100)} %`)
    .join(" · ");
}

function classifyCell(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): { semantic: SemanticClass; latent: [number, number, number, number] } {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  let edgeX = 0;
  let edgeY = 0;
  let diag = 0;
  let varianceAcc = 0;
  let lumaSum = 0;
  let lumaSq = 0;

  const step = Math.max(1, Math.floor(Math.max(x1 - x0, y1 - y0) / 48));

  const yAt = (x: number, y: number) => {
    const i = (clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)) * 4;
    return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  };

  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * width + x) * 4;
      const rr = data[i];
      const gg = data[i + 1];
      const bb = data[i + 2];
      const yy = 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
      r += rr;
      g += gg;
      b += bb;
      lumaSum += yy;
      lumaSq += yy * yy;
      edgeX += Math.abs(yy - yAt(x + step, y));
      edgeY += Math.abs(yy - yAt(x, y + step));
      diag += Math.abs(yy - yAt(x + step, y + step));
      count += 1;
    }
  }

  if (!count) {
    return { semantic: SemanticClass.Flat, latent: [0, 0, 0, 0] };
  }

  r /= count;
  g /= count;
  b /= count;
  const mean = lumaSum / count;
  varianceAcc = Math.max(0, lumaSq / count - mean * mean);
  const ex = edgeX / count / 255;
  const ey = edgeY / count / 255;
  const ed = diag / count / 255;
  const variance = Math.sqrt(varianceAcc) / 128;
  const maxRgb = Math.max(r, g, b);
  const minRgb = Math.min(r, g, b);
  const saturation = maxRgb > 0 ? (maxRgb - minRgb) / maxRgb : 0;

  const sky =
    b > r * 1.08 &&
    b > g * 1.02 &&
    mean > 80 &&
    saturation > 0.10;
  const skin =
    r > g &&
    g > b * 0.92 &&
    r > 85 &&
    g > 45 &&
    b > 30 &&
    (r - b) > 18 &&
    saturation > 0.12;
  const edge = (ex + ey) * 0.5;
  const geometry = edge > 0.075 && saturation < 0.42;
  const flat = edge < 0.022 && variance < 0.18;

  const semantic =
    sky ? SemanticClass.Sky :
    skin ? SemanticClass.Skin :
    geometry ? SemanticClass.Geometry :
    flat ? SemanticClass.Flat :
    SemanticClass.Texture;

  return {
    semantic,
    latent: [
      Math.round(clamp(ex, 0, 1) * 255),
      Math.round(clamp(ey, 0, 1) * 255),
      Math.round(clamp(ed, 0, 1) * 255),
      Math.round(clamp(variance, 0, 1) * 255),
    ],
  };
}

function analyzeMaps(image: ImageData): { semantic: Uint8Array; latent: Uint8Array } {
  const semantic = new Uint8Array(GRID_W * GRID_H);
  const latent = new Uint8Array(GRID_W * GRID_H * 4);

  for (let gy = 0; gy < GRID_H; gy += 1) {
    for (let gx = 0; gx < GRID_W; gx += 1) {
      const x0 = Math.floor(gx * image.width / GRID_W);
      const x1 = Math.max(x0 + 1, Math.floor((gx + 1) * image.width / GRID_W));
      const y0 = Math.floor(gy * image.height / GRID_H);
      const y1 = Math.max(y0 + 1, Math.floor((gy + 1) * image.height / GRID_H));
      const result = classifyCell(image.data, image.width, image.height, x0, y0, x1, y1);
      const index = gy * GRID_W + gx;
      semantic[index] = result.semantic;
      latent.set(result.latent, index * 4);
    }
  }

  return { semantic, latent };
}

function makeHaarLowPass(image: ImageData): HTMLCanvasElement {
  const outWidth = Math.max(1, Math.ceil(image.width / 2));
  const outHeight = Math.max(1, Math.ceil(image.height / 2));
  const canvas = document.createElement("canvas");
  canvas.width = outWidth;
  canvas.height = outHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas DWT indisponible.");
  const out = ctx.createImageData(outWidth, outHeight);

  for (let oy = 0; oy < outHeight; oy += 1) {
    for (let ox = 0; ox < outWidth; ox += 1) {
      const sx = ox * 2;
      const sy = oy * 2;
      const samples: number[] = [];
      for (const dy of [0, 1]) {
        for (const dx of [0, 1]) {
          const x = Math.min(image.width - 1, sx + dx);
          const y = Math.min(image.height - 1, sy + dy);
          samples.push((y * image.width + x) * 4);
        }
      }

      const target = (oy * outWidth + ox) * 4;
      for (let c = 0; c < 3; c += 1) {
        out.data[target + c] = Math.round(
          (image.data[samples[0] + c] +
            image.data[samples[1] + c] +
            image.data[samples[2] + c] +
            image.data[samples[3] + c]) / 4,
        );
      }
      out.data[target + 3] = 255;
    }
  }

  ctx.putImageData(out, 0, 0);
  return canvas;
}

function mimeCode(type: string): number {
  return type.includes("webp") ? 1 : 2;
}

function mimeFromCode(value: number): string {
  return value === 1 ? "image/webp" : "image/jpeg";
}

function writeU32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value, true);
}

function parseU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

export async function encodeAuraVision(
  source: Blob,
  onProgress?: (ratio: number, label: string) => void,
): Promise<AuraVisionEncodeResult> {
  onProgress?.(0.03, "Aura-Vision · décodage source");
  const decoded = await decodeImageFile(source);
  try {
    const pixels = decoded.width * decoded.height;
    if (pixels > MAX_ENCODE_PIXELS) {
      throw new Error(
        `Aura-Vision v0.1 limite l'analyse DWT à ${(MAX_ENCODE_PIXELS / 1_000_000).toFixed(0)} MP pour rester stable sur mobile.`,
      );
    }

    const canvas = document.createElement("canvas");
    canvas.width = decoded.width;
    canvas.height = decoded.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Canvas source Aura-Vision indisponible.");
    ctx.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);

    onProgress?.(0.18, "Aura-Vision · DWT Haar + cartes de caractéristiques");
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const baseCanvas = makeHaarLowPass(image);
    const maps = analyzeMaps(image);

    onProgress?.(0.48, "Aura-Vision · compression du flux structurel");
    let baseBlob: Blob;
    try {
      baseBlob = await canvasToBlob(baseCanvas, "image/webp", 0.82);
      if (!baseBlob.size) throw new Error("WebP vide");
    } catch {
      baseBlob = await canvasToBlob(baseCanvas, "image/jpeg", 0.86);
    }

    const metadata = new TextEncoder().encode(JSON.stringify({
      codec: "Aura-Vision AV-1X",
      version: VERSION,
      architecture: "hybrid-structure-texture",
      transform: "haar-ll",
      semantic: "heuristic-grid-v1",
      latent: "deterministic-texture-descriptor-v1",
      learnedVae: false,
      createdUtc: new Date().toISOString(),
    }));

    const baseBytes = new Uint8Array(await baseBlob.arrayBuffer());
    const total =
      HEADER_BYTES +
      baseBytes.byteLength +
      maps.semantic.byteLength +
      maps.latent.byteLength +
      metadata.byteLength;
    const output = new Uint8Array(total);
    output.set(MAGIC, 0);
    const view = new DataView(output.buffer);
    view.setUint16(4, VERSION, true);
    view.setUint16(6, 0, true);
    writeU32(view, 8, decoded.width);
    writeU32(view, 12, decoded.height);
    writeU32(view, 16, baseCanvas.width);
    writeU32(view, 20, baseCanvas.height);
    view.setUint16(24, GRID_W, true);
    view.setUint16(26, GRID_H, true);
    view.setUint8(28, mimeCode(baseBlob.type));
    writeU32(view, 32, baseBytes.byteLength);
    writeU32(view, 36, maps.semantic.byteLength);
    writeU32(view, 40, maps.latent.byteLength);
    writeU32(view, 44, metadata.byteLength);

    let offset = HEADER_BYTES;
    output.set(baseBytes, offset);
    offset += baseBytes.byteLength;
    output.set(maps.semantic, offset);
    offset += maps.semantic.byteLength;
    output.set(maps.latent, offset);
    offset += maps.latent.byteLength;
    output.set(metadata, offset);

    baseCanvas.width = 1;
    baseCanvas.height = 1;
    canvas.width = 1;
    canvas.height = 1;

    onProgress?.(1, "Aura-Vision · conteneur AV-1X prêt");
    const blob = new Blob([output.buffer], { type: "application/x-aura-vision" });
    return {
      blob,
      width: decoded.width,
      height: decoded.height,
      baseWidth: Math.ceil(decoded.width / 2),
      baseHeight: Math.ceil(decoded.height / 2),
      baseBytes: baseBytes.byteLength,
      semanticBytes: maps.semantic.byteLength,
      latentBytes: maps.latent.byteLength,
      ratioVsRgba: blob.size / Math.max(1, decoded.width * decoded.height * 4),
      semanticSummary: semanticSummary(maps.semantic),
    };
  } finally {
    decoded.close();
  }
}

interface ParsedAura {
  width: number;
  height: number;
  baseWidth: number;
  baseHeight: number;
  gridW: number;
  gridH: number;
  baseMime: string;
  base: Blob;
  semantic: Uint8Array;
  latent: Uint8Array;
  metadata: Record<string, unknown>;
}

async function parseAuraVision(blob: Blob): Promise<ParsedAura> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.byteLength < HEADER_BYTES) throw new Error("Fichier AV-1X tronqué.");
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (bytes[i] !== MAGIC[i]) throw new Error("Signature Aura-Vision AV-1X absente.");
  }

  const view = new DataView(bytes.buffer);
  const version = view.getUint16(4, true);
  if (version !== VERSION) throw new Error(`Version AV-1X non prise en charge (${version}).`);

  const width = parseU32(view, 8);
  const height = parseU32(view, 12);
  const baseWidth = parseU32(view, 16);
  const baseHeight = parseU32(view, 20);
  const gridW = view.getUint16(24, true);
  const gridH = view.getUint16(26, true);
  const baseMime = mimeFromCode(view.getUint8(28));
  const baseLength = parseU32(view, 32);
  const semanticLength = parseU32(view, 36);
  const latentLength = parseU32(view, 40);
  const metadataLength = parseU32(view, 44);

  const expected =
    HEADER_BYTES + baseLength + semanticLength + latentLength + metadataLength;
  if (expected > bytes.byteLength) throw new Error("Index AV-1X invalide ou fichier incomplet.");

  let offset = HEADER_BYTES;
  const base = new Blob([bytes.slice(offset, offset + baseLength)], { type: baseMime });
  offset += baseLength;
  const semantic = bytes.slice(offset, offset + semanticLength);
  offset += semanticLength;
  const latent = bytes.slice(offset, offset + latentLength);
  offset += latentLength;
  const metadataBytes = bytes.slice(offset, offset + metadataLength);

  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(new TextDecoder().decode(metadataBytes)) as Record<string, unknown>;
  } catch {
    metadata = {};
  }

  if (!width || !height || !baseWidth || !baseHeight || !gridW || !gridH) {
    throw new Error("Dimensions AV-1X invalides.");
  }

  return {
    width,
    height,
    baseWidth,
    baseHeight,
    gridW,
    gridH,
    baseMime,
    base,
    semantic,
    latent,
    metadata,
  };
}

function ssimCanvas(a: HTMLCanvasElement, b: HTMLCanvasElement): number {
  const width = 128;
  const height = Math.max(16, Math.round(width * a.height / Math.max(1, a.width)));
  const ca = document.createElement("canvas");
  const cb = document.createElement("canvas");
  ca.width = cb.width = width;
  ca.height = cb.height = height;
  const actx = ca.getContext("2d", { willReadFrequently: true });
  const bctx = cb.getContext("2d", { willReadFrequently: true });
  if (!actx || !bctx) return 0;
  actx.drawImage(a, 0, 0, width, height);
  bctx.drawImage(b, 0, 0, width, height);
  const ad = actx.getImageData(0, 0, width, height).data;
  const bd = bctx.getImageData(0, 0, width, height).data;

  let meanA = 0;
  let meanB = 0;
  const n = width * height;
  const ya = new Float32Array(n);
  const yb = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p += 1, i += 4) {
    ya[p] = 0.2126 * ad[i] + 0.7152 * ad[i + 1] + 0.0722 * ad[i + 2];
    yb[p] = 0.2126 * bd[i] + 0.7152 * bd[i + 1] + 0.0722 * bd[i + 2];
    meanA += ya[p];
    meanB += yb[p];
  }
  meanA /= n;
  meanB /= n;

  let varA = 0;
  let varB = 0;
  let covariance = 0;
  for (let p = 0; p < n; p += 1) {
    const da = ya[p] - meanA;
    const db = yb[p] - meanB;
    varA += da * da;
    varB += db * db;
    covariance += da * db;
  }
  const denom = Math.max(1, n - 1);
  varA /= denom;
  varB /= denom;
  covariance /= denom;
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  const numerator = (2 * meanA * meanB + c1) * (2 * covariance + c2);
  const denominator = (meanA * meanA + meanB * meanB + c1) * (varA + varB + c2);
  return denominator > 0 ? clamp(numerator / denominator, -1, 1) : 1;
}

function semanticBlendAlpha(classId: number, latent: Uint8Array, index: number): number {
  const edge = ((latent[index * 4] ?? 0) + (latent[index * 4 + 1] ?? 0)) / 510;
  const texture = (latent[index * 4 + 3] ?? 0) / 255;
  const base =
    classId === SemanticClass.Sky ? 0.30 :
    classId === SemanticClass.Skin ? 0.46 :
    classId === SemanticClass.Geometry ? 0.86 :
    classId === SemanticClass.Texture ? 0.72 :
    0.34;
  return clamp(base + edge * 0.12 + texture * 0.08, 0.25, 0.94);
}

function compositeSemanticGuide(
  deterministic: HTMLCanvasElement,
  neural: HTMLCanvasElement,
  semantic: Uint8Array,
  latent: Uint8Array,
  gridW: number,
  gridH: number,
): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = deterministic.width;
  out.height = deterministic.height;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("Canvas de fusion AV-1X indisponible.");
  ctx.drawImage(deterministic, 0, 0);

  for (let gy = 0; gy < gridH; gy += 1) {
    for (let gx = 0; gx < gridW; gx += 1) {
      const index = gy * gridW + gx;
      const x0 = Math.floor(gx * out.width / gridW);
      const x1 = Math.ceil((gx + 1) * out.width / gridW);
      const y0 = Math.floor(gy * out.height / gridH);
      const y1 = Math.ceil((gy + 1) * out.height / gridH);
      const w = Math.max(1, x1 - x0);
      const h = Math.max(1, y1 - y0);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y0, w, h);
      ctx.clip();
      ctx.globalAlpha = semanticBlendAlpha(semantic[index] ?? 0, latent, index);
      ctx.drawImage(neural, 0, 0, out.width, out.height);
      ctx.restore();
    }
  }

  return out;
}

export async function decodeAuraVision(
  blob: Blob,
  options: AuraVisionDecodeOptions = {},
): Promise<AuraVisionDecodeResult> {
  const {
    upscaleFactor = 1,
    useAi = true,
    structuralThreshold = 0.95,
    onProgress,
  } = options;

  onProgress?.(0.04, "Aura-Vision · lecture du conteneur");
  const parsed = await parseAuraVision(blob);
  const baseDecoded = await decodeImageFile(parsed.base);
  try {
    const width = parsed.width * upscaleFactor;
    const height = parsed.height * upscaleFactor;
    const android = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
    const maxOutputPixels = android ? 24_000_000 : 80_000_000;
    if (width * height > maxOutputPixels) {
      throw new Error(
        `Décodage AV-1X ${width}×${height} refusé : budget mémoire local dépassé (${(maxOutputPixels / 1_000_000).toFixed(0)} MP sûrs sur ce profil).`,
      );
    }

    const deterministic = document.createElement("canvas");
    deterministic.width = width;
    deterministic.height = height;
    const deterministicCtx = deterministic.getContext("2d");
    if (!deterministicCtx) throw new Error("Canvas de reconstruction AV-1X indisponible.");
    deterministicCtx.imageSmoothingEnabled = true;
    deterministicCtx.imageSmoothingQuality = "high";
    deterministicCtx.drawImage(baseDecoded.source, 0, 0, width, height);

    const latentMean =
      parsed.latent.length
        ? parsed.latent.reduce((acc, value) => acc + value, 0) / parsed.latent.length / 255
        : 0;
    applyFinalAdaptiveSharpen(deterministic, {
      amount: 0.10 + latentMean * 0.18,
      edgeThreshold: 5,
      haloGuard: 0.82,
      maxCorrection: 10,
    });

    let finalCanvas = deterministic;
    let usedAi = false;
    let structuralSsim: number | null = null;
    let fallbackReason: string | undefined;

    const model = loadedModel();
    if (useAi && model) {
      onProgress?.(0.35, `Aura-Vision · reconstruction neuronale x${model.scale}`);
      try {
        const baseCanvas = document.createElement("canvas");
        baseCanvas.width = parsed.baseWidth;
        baseCanvas.height = parsed.baseHeight;
        const baseCtx = baseCanvas.getContext("2d");
        if (!baseCtx) throw new Error("Canvas neuronal AV-1X indisponible.");
        baseCtx.drawImage(baseDecoded.source, 0, 0);

        const neuralRaw = await upscaleWithAi(baseCanvas, (ratio, label) => {
          onProgress?.(0.35 + ratio * 0.40, label);
        });
        const neural = document.createElement("canvas");
        neural.width = width;
        neural.height = height;
        const neuralCtx = neural.getContext("2d");
        if (!neuralCtx) throw new Error("Canvas neuronal final indisponible.");
        neuralCtx.imageSmoothingEnabled = true;
        neuralCtx.imageSmoothingQuality = "high";
        neuralCtx.drawImage(neuralRaw, 0, 0, width, height);

        structuralSsim = ssimCanvas(deterministic, neural);
        if (structuralSsim >= structuralThreshold) {
          onProgress?.(0.80, "Aura-Vision · fusion sémantique structure/texture");
          finalCanvas = compositeSemanticGuide(
            deterministic,
            neural,
            parsed.semantic,
            parsed.latent,
            parsed.gridW,
            parsed.gridH,
          );
          usedAi = true;
        } else {
          fallbackReason =
            `Garde-fou structurel : SSIM ${structuralSsim.toFixed(4)} < ${structuralThreshold.toFixed(2)}. Repli déterministe.`;
        }

        neuralRaw.width = 1;
        neuralRaw.height = 1;
        neural.width = 1;
        neural.height = 1;
        baseCanvas.width = 1;
        baseCanvas.height = 1;
      } catch (reason) {
        fallbackReason =
          "Reconstruction neuronale indisponible : " +
          (reason instanceof Error ? reason.message : "raison inconnue") +
          ". Repli déterministe.";
      }
    } else if (useAi && !model) {
      fallbackReason = "Aucun modèle ONNX chargé : reconstruction déterministe AV-1X.";
    }

    onProgress?.(0.92, "Aura-Vision · export sans perte");
    const outputBlob = await canvasToBlob(finalCanvas, "image/png");
    onProgress?.(1, "Aura-Vision · reconstruction terminée");

    if (finalCanvas !== deterministic) {
      finalCanvas.width = 1;
      finalCanvas.height = 1;
    }
    deterministic.width = 1;
    deterministic.height = 1;

    return {
      blob: outputBlob,
      width,
      height,
      usedAi,
      structuralSsim,
      fallbackReason,
      semanticSummary: semanticSummary(parsed.semantic),
    };
  } finally {
    baseDecoded.close();
  }
}
