/**
 * Noyau d'inférence ONNX partagé entre le Web Worker et le repli en thread
 * principal. Aucun accès au DOM ici : ce module doit tourner dans un worker.
 *
 * IMPORTANT — binaire WASM : le bundle `onnxruntime-web/webgpu` (1.30) embarque
 * la glue Emscripten « asyncify ». Le binaire servi doit être
 * ort-wasm-simd-threaded.asyncify.wasm. Le binaire « jsep » appartient à une
 * autre glue : l'associer à ce bundle fait planter l'initialisation du runtime.
 */

import wasmBinaryUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";

export type OrtModule = typeof import("onnxruntime-web/webgpu");
export type OrtSession = Awaited<ReturnType<OrtModule["InferenceSession"]["create"]>>;

export type IoType = "float32" | "float16";

export interface ModelMeta {
  scale: number;
  inputName: string;
  outputName: string;
  provider: string;
  /** Taille d'entrée imposée par le modèle (null = dynamique). */
  fixedWidth: number | null;
  fixedHeight: number | null;
  inputType: IoType;
}

export interface KeepRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TileResult {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Les réseaux SwinIR/Swin2SR exigent des côtés multiples de la fenêtre (8). */
const WINDOW_MULTIPLE = 8;

let ortModule: OrtModule | null = null;
let configuredThreads = 1;

export function hasWebGpu(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator && Boolean((navigator as Navigator & { gpu?: unknown }).gpu);
}

export function isIsolated(): boolean {
  return typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;
}

/** Nombre de threads WASM raisonnable pour cet appareil (1 sans isolation). */
export function recommendedThreads(): number {
  if (!isIsolated()) return 1;
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 2 : 2;
  return Math.max(1, Math.min(4, Math.floor(cores / 2)));
}

/**
 * Le nombre de threads est figé à la première initialisation du runtime :
 * pour changer de configuration, il faut un nouveau worker.
 */
export async function getOrt(threads: number): Promise<OrtModule> {
  if (ortModule) return ortModule;
  const mod = await import("onnxruntime-web/webgpu");
  mod.env.wasm.wasmPaths = { wasm: wasmBinaryUrl };
  configuredThreads = isIsolated() ? Math.max(1, threads) : 1;
  mod.env.wasm.numThreads = configuredThreads;
  mod.env.wasm.proxy = false;
  mod.env.logLevel = "error";
  ortModule = mod;
  return mod;
}

export function activeThreads(): number {
  return configuredThreads;
}

export async function createSession(
  ort: OrtModule,
  weights: Uint8Array,
  preferGpu: boolean,
): Promise<{ session: OrtSession; provider: string }> {
  const attempts = preferGpu && hasWebGpu() ? ["webgpu", "wasm"] : ["wasm"];
  const failures: string[] = [];

  for (const provider of attempts) {
    try {
      const session = await ort.InferenceSession.create(weights, {
        executionProviders: [provider],
        graphOptimizationLevel: "all",
      });
      return { session, provider };
    } catch (reason) {
      failures.push(provider.toUpperCase() + " : " + errorText(reason));
    }
  }
  throw new Error("Le modèle n'a pas pu être initialisé. " + failures.join(" | "));
}

export function errorText(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  return "raison inconnue";
}

type OrtResult = Record<string, { dims: readonly number[]; data: unknown; type?: string; dispose?: () => void }>;

function disposeAll(result: OrtResult): void {
  for (const tensor of Object.values(result)) {
    try {
      tensor.dispose?.();
    } catch {
      /* déjà libéré */
    }
  }
}

/* ---------------- float16 ---------------- */

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

export function toHalf(value: number): number {
  f32[0] = value;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  let exp = ((x >>> 23) & 0xff) - 127 + 15;
  let mant = x & 0x7fffff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant = (mant | 0x800000) >> (1 - exp);
    return sign | ((mant + 0x1000) >> 13);
  }
  if (exp >= 31) return sign | 0x7c00;
  const half = sign | (exp << 10) | ((mant + 0x1000) >> 13);
  return half;
}

export function fromHalf(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const mant = h & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 31) return mant ? NaN : sign * Infinity;
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}

function makeInput(ort: OrtModule, values: Float32Array, dims: number[], type: IoType) {
  if (type === "float16") {
    const half = new Uint16Array(values.length);
    for (let i = 0; i < values.length; i += 1) half[i] = toHalf(values[i]);
    return new ort.Tensor("float16", half, dims);
  }
  return new ort.Tensor("float32", values, dims);
}

/** Convertit une sortie float32 ou float16 en Float32Array. */
function readOutput(output: { type?: string; data: unknown }): Float32Array {
  const data = output.data as ArrayLike<number>;
  const F16 = (globalThis as { Float16Array?: new (...args: never[]) => unknown }).Float16Array;
  if (output.type === "float16" && !(F16 && data instanceof F16)) {
    const out = new Float32Array(data.length);
    for (let i = 0; i < data.length; i += 1) out[i] = fromHalf(data[i]);
    return out;
  }
  return data instanceof Float32Array ? data : Float32Array.from(data);
}

interface InputSpec {
  fixedWidth: number | null;
  fixedHeight: number | null;
  inputType: IoType;
}

function inspectInput(session: OrtSession): InputSpec {
  const metadata = (session as unknown as {
    inputMetadata?: readonly { isTensor: boolean; type?: string; shape?: readonly (number | string)[] }[];
  }).inputMetadata?.[0];
  const shape = metadata?.isTensor ? metadata.shape ?? [] : [];
  const height = typeof shape[2] === "number" && shape[2] > 0 ? shape[2] : null;
  const width = typeof shape[3] === "number" && shape[3] > 0 ? shape[3] : null;
  const inputType: IoType = metadata?.isTensor && metadata.type === "float16" ? "float16" : "float32";
  return { fixedWidth: width, fixedHeight: height, inputType };
}

async function runProbe(
  ort: OrtModule,
  session: OrtSession,
  inputName: string,
  outputName: string,
  side: number,
  type: IoType = "float32",
  width = side,
): Promise<number> {
  const probe = makeInput(ort, new Float32Array(3 * side * width).fill(0.5), [1, 3, side, width], type);
  let result: OrtResult;
  try {
    result = (await session.run({ [inputName]: probe })) as unknown as OrtResult;
  } finally {
    probe.dispose();
  }
  const output = result[outputName];
  const height = output && output.dims.length === 4 ? Number(output.dims[2]) : NaN;
  disposeAll(result);
  if (!Number.isFinite(height)) throw new Error("Sortie du modèle inattendue : un tenseur NCHW est requis.");
  return height / side;
}

/** Mesure le facteur réel et valide une vraie tuile de travail. */
export async function probeModel(
  ort: OrtModule,
  session: OrtSession,
  provider: string,
  tileSide: number,
): Promise<ModelMeta> {
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  if (!inputName || !outputName) throw new Error("Modèle ONNX sans entrée/sortie exploitable.");

  const spec = inspectInput(session);

  if (spec.fixedWidth && spec.fixedHeight) {
    // Modèle à entrée figée (exports Qualcomm, TFLite convertis…) :
    // une seule sonde, à la taille imposée.
    const fixedScale = await runProbe(
      ort, session, inputName, outputName, spec.fixedHeight, spec.inputType, spec.fixedWidth,
    );
    if (!Number.isFinite(fixedScale) || fixedScale < 1 || fixedScale > 8) {
      throw new Error(`Facteur d'échelle du modèle non exploitable (${fixedScale}).`);
    }
    return { scale: Math.round(fixedScale * 100) / 100, inputName, outputName, provider, ...spec };
  }

  const rawScale = await runProbe(ort, session, inputName, outputName, 64, spec.inputType);
  if (!Number.isFinite(rawScale) || rawScale < 1 || rawScale > 8) {
    throw new Error(`Facteur d'échelle du modèle non exploitable (${rawScale}).`);
  }
  const workScale = await runProbe(ort, session, inputName, outputName, tileSide, spec.inputType);
  if (Math.abs(workScale - rawScale) > 0.01) {
    throw new Error("Le modèle refuse la taille de tuile réelle du navigateur.");
  }
  return { scale: Math.round(rawScale * 100) / 100, inputName, outputName, provider, ...spec };
}

function roundUpToWindow(value: number): number {
  return Math.ceil(value / WINDOW_MULTIPLE) * WINDOW_MULTIPLE;
}

/**
 * Inférence d'une tuile RGBA. La tuile est complétée par réplication de bord
 * jusqu'au multiple de fenêtre ; seule la zone `keep` (coordonnées source,
 * relatives à la tuile) est renvoyée, déjà convertie en RGBA 8 bits.
 */
export async function runTile(
  ort: OrtModule,
  session: OrtSession,
  meta: ModelMeta,
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  keep: KeepRect,
): Promise<TileResult> {
  const paddedWidth = meta.fixedWidth ?? roundUpToWindow(width);
  const paddedHeight = meta.fixedHeight ?? roundUpToWindow(height);
  if (width > paddedWidth || height > paddedHeight) {
    throw new Error(`Tuile ${width}×${height} plus grande que l'entrée fixe du modèle ${paddedWidth}×${paddedHeight}.`);
  }
  const plane = paddedWidth * paddedHeight;
  const values = new Float32Array(plane * 3);

  for (let y = 0; y < paddedHeight; y += 1) {
    const sourceRow = Math.min(y, height - 1) * width;
    const row = y * paddedWidth;
    for (let x = 0; x < paddedWidth; x += 1) {
      const offset = (sourceRow + Math.min(x, width - 1)) * 4;
      const index = row + x;
      values[index] = rgba[offset] / 255;
      values[plane + index] = rgba[offset + 1] / 255;
      values[plane * 2 + index] = rgba[offset + 2] / 255;
    }
  }

  const tensor = makeInput(ort, values, [1, 3, paddedHeight, paddedWidth], meta.inputType);
  let result: OrtResult;
  try {
    result = (await session.run({ [meta.inputName]: tensor })) as unknown as OrtResult;
  } finally {
    tensor.dispose();
  }

  try {
    const output = result[meta.outputName];
    if (!output || output.dims.length !== 4) throw new Error("Sortie IA invalide sur une tuile.");
    const outWidth = Number(output.dims[3]);
    const outHeight = Number(output.dims[2]);
    const data = readOutput(output as { type?: string; data: unknown });
    const outPlane = outWidth * outHeight;
    const scale = meta.scale;

    const keepX = Math.round(keep.x * scale);
    const keepY = Math.round(keep.y * scale);
    const keepWidth = Math.max(0, Math.min(Math.round(keep.width * scale), outWidth - keepX));
    const keepHeight = Math.max(0, Math.min(Math.round(keep.height * scale), outHeight - keepY));
    const patch = new Uint8ClampedArray(keepWidth * keepHeight * 4);

    for (let y = 0; y < keepHeight; y += 1) {
      const sourceRow = (keepY + y) * outWidth + keepX;
      const targetRow = y * keepWidth * 4;
      for (let x = 0; x < keepWidth; x += 1) {
        const sourceIndex = sourceRow + x;
        const target = targetRow + x * 4;
        // Uint8ClampedArray borne et arrondit automatiquement.
        patch[target] = data[sourceIndex] * 255;
        patch[target + 1] = data[outPlane + sourceIndex] * 255;
        patch[target + 2] = data[outPlane * 2 + sourceIndex] * 255;
        patch[target + 3] = 255;
      }
    }
    return { data: patch, width: keepWidth, height: keepHeight };
  } finally {
    disposeAll(result);
  }
}

export async function releaseSession(session: OrtSession | null): Promise<void> {
  const current = session as (OrtSession & { release?: () => Promise<void> }) | null;
  await current?.release?.().catch(() => undefined);
}
