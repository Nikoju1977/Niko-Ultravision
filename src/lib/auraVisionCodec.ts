import { decodeImageFile } from "./imageDecode";
import { isCancelledError } from "./cancellation";
import {
  AI_MODEL_PRESETS,
  loadAiModel,
  loadedModel,
  upscaleWithAi,
} from "./aiUpscaler";
import { applyFinalAdaptiveSharpen } from "./finalSharpen";
import {
  DEFAULT_AURA_QUALITY_RULES,
  estimateAuraMemoryMb,
  lanczos3Resample,
  validateAuraGeneration,
  type AuraQualityReport,
} from "./auraQualityController";

const MAGIC = [0x41, 0x56, 0x31, 0x58]; // AV1X
const HEADER_BYTES = 48;
const VERSION = 1;
const VERSION_STRING = "1.0.0";
const MAGIC_IDENTIFIER = "AURA-VISION-AV1X";
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

export interface AuraVisionManifest {
  header: {
    magic_identifier: string;
    version: string;
    encoding_metadata: {
      timestamp: string;
      authoring_tool: string;
      compression_level: "ultra_latent";
    };
  };
  geometry_and_display: {
    base_resolution: { width: number; height: number; note: string };
    target_display_resolution: { width: number; height: number; note: string };
    colorimetry: {
      requested: { space: "Rec.2020"; bit_depth: 10; hdr_profile: "HLG" };
      stored_payload: { space: "browser-rgb"; bit_depth: 8; hdr_profile: "SDR"; note: string };
    };
  };
  data_streams: {
    base_stream: {
      type: "discrete_wavelet_transform_low_freq";
      payload_offset_bytes: number;
      payload_size_bytes: number;
      entropy_coding: string;
    };
    ai_enhancement_payload: {
      semantic_segmentation: {
        classes_detected: string[];
        map_encoding: "RLE_compressed";
        offset_bytes: number;
      };
      latent_texture_vectors: {
        vae_model_reference: string | null;
        tensor_shape: [number, number, number, number];
        quantization: "INT8";
        implementation: "deterministic_descriptor_v1";
      };
      reconstruction_directives: {
        recommended_model: "SwinIR_Restorer";
        denoising_strength: number;
        sharpening_factor: number;
      };
    };
  };
  dimensional_control: {
    structural_integrity: {
      ssim_minimum_threshold: number;
      tolerance_zones: {
        text: "strict";
        skin: "moderate";
        sky: "flexible";
      };
    };
    cryptographic_validation: {
      reference_hash_sha256: string;
      hash_scope: string;
    };
  };
  quality_assurance_and_fallback: {
    amdec_failure_modes: {
      ai_hallucination_detected: {
        trigger_condition: "structural_similarity < threshold";
        action: "rollback_to_base_stream";
        fallback_filter: "Lanczos3";
      };
      hardware_timeout: {
        trigger_condition: "inference_time_ms > 150";
        action: "downgrade_ai_model";
        fallback_model: "SwinIR_Fast_Light";
        implemented_fallback_model: string;
      };
    };
  };
  advanced_dimensional_control: {
    global_metrics: {
      ssim_minimum: number;
      psnr_target_db: number;
    };
    geometric_tolerances: Array<{
      roi_name: string;
      semantic_class: string;
      max_edge_displacement_pixels?: number;
      straightness_preservation_index?: number;
      enforcement: "critical" | "warning";
    }>;
  };
  hardware_execution_directives: {
    preferred_compute_unit: "NPU";
    memory_footprint_limit_mb: number;
    quantization_fallback_allowed: true;
    browser_compute_note: string;
  };
  provenance_and_security: {
    c2pa_manifest: {
      assertion_type: "c2pa.actions.ai_enhanced";
      base_image_hash: string;
      ai_generation_ratio_percent: number;
      signature_authority: "Vision-IA Encoder Core";
      signed: false;
      note: string;
    };
  };
  implementation_status: {
    learned_vae: false;
    cabac: false;
    native_10bit_hdr: false;
    isobmff: false;
    note: string;
  };
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
  manifest: AuraVisionManifest;
}

export interface AuraVisionDecodeResult {
  blob: Blob;
  width: number;
  height: number;
  usedAi: boolean;
  structuralSsim: number | null;
  fallbackReason?: string;
  semanticSummary: string;
  manifest: AuraVisionManifest | null;
  qualityReport: AuraQualityReport | null;
  inferenceTimeMs: number | null;
  modelDowngraded: boolean;
  fallbackFilter: "Lanczos3" | null;
  actualComputeUnit: string;
  integrityVerified: boolean | null;
  aiGenerationRatioPercent: number;
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

function semanticClasses(map: Uint8Array): string[] {
  const present = new Set<number>();
  for (const value of map) present.add(value);
  const classes: string[] = [];
  if (present.has(SemanticClass.Skin)) classes.push("skin");
  if (present.has(SemanticClass.Geometry)) classes.push("text", "architecture");
  if (present.has(SemanticClass.Sky)) classes.push("sky");
  if (present.has(SemanticClass.Texture)) classes.push("texture");
  if (present.has(SemanticClass.Flat)) classes.push("flat");
  return classes;
}

function rleEncode(input: Uint8Array): Uint8Array {
  if (!input.length) return new Uint8Array();
  const out: number[] = [];
  let value = input[0];
  let count = 1;
  for (let i = 1; i < input.length; i += 1) {
    const next = input[i];
    if (next === value && count < 255) {
      count += 1;
    } else {
      out.push(value, count);
      value = next;
      count = 1;
    }
  }
  out.push(value, count);
  return new Uint8Array(out);
}

function rleDecode(input: Uint8Array, expectedLength: number): Uint8Array {
  const out = new Uint8Array(expectedLength);
  let offset = 0;
  for (let i = 0; i + 1 < input.length && offset < expectedLength; i += 2) {
    const value = input[i];
    const count = input[i + 1];
    out.fill(value, offset, Math.min(expectedLength, offset + count));
    offset += count;
  }
  if (offset !== expectedLength) {
    throw new Error("Carte sémantique RLE AV-1X invalide.");
  }
  return out;
}

async function sha256Hex(parts: Uint8Array[]): Promise<string> {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
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

    const baseBytes = new Uint8Array(await baseBlob.arrayBuffer());
    const semanticRle = rleEncode(maps.semantic);
    const hash = await sha256Hex([baseBytes, semanticRle, maps.latent]);
    const baseHash = await sha256Hex([baseBytes]);
    const baseOffset = HEADER_BYTES;
    const semanticOffset = baseOffset + baseBytes.byteLength;
    const latentOffset = semanticOffset + semanticRle.byteLength;
    const timestamp = new Date().toISOString();

    const manifest: AuraVisionManifest = {
      header: {
        magic_identifier: MAGIC_IDENTIFIER,
        version: VERSION_STRING,
        encoding_metadata: {
          timestamp,
          authoring_tool: "Vision-IA Encoder Core v1.2",
          compression_level: "ultra_latent",
        },
      },
      geometry_and_display: {
        base_resolution: {
          width: baseCanvas.width,
          height: baseCanvas.height,
          note: "Résolution physique stockée dans le flux structurel basse fréquence.",
        },
        target_display_resolution: {
          width: decoded.width * 2,
          height: decoded.height * 2,
          note: "Cible de reconstruction native recommandée par AV-1X v1.0.",
        },
        colorimetry: {
          requested: {
            space: "Rec.2020",
            bit_depth: 10,
            hdr_profile: "HLG",
          },
          stored_payload: {
            space: "browser-rgb",
            bit_depth: 8,
            hdr_profile: "SDR",
            note: "Le prototype navigateur v1.0 ne réalise pas encore une chaîne Rec.2020 10-bit HLG native.",
          },
        },
      },
      data_streams: {
        base_stream: {
          type: "discrete_wavelet_transform_low_freq",
          payload_offset_bytes: baseOffset,
          payload_size_bytes: baseBytes.byteLength,
          entropy_coding: baseBlob.type.includes("webp") ? "WebP entropy coding" : "JPEG entropy coding",
        },
        ai_enhancement_payload: {
          semantic_segmentation: {
            classes_detected: semanticClasses(maps.semantic),
            map_encoding: "RLE_compressed",
            offset_bytes: semanticOffset,
          },
          latent_texture_vectors: {
            vae_model_reference: null,
            tensor_shape: [1, 4, GRID_H, GRID_W],
            quantization: "INT8",
            implementation: "deterministic_descriptor_v1",
          },
          reconstruction_directives: {
            recommended_model: "SwinIR_Restorer",
            denoising_strength: 0.3,
            sharpening_factor: 1.2,
          },
        },
      },
      dimensional_control: {
        structural_integrity: {
          ssim_minimum_threshold: DEFAULT_AURA_QUALITY_RULES.ssimMinimum,
          tolerance_zones: {
            text: "strict",
            skin: "moderate",
            sky: "flexible",
          },
        },
        cryptographic_validation: {
          reference_hash_sha256: hash,
          hash_scope: "base_stream+semantic_rle+latent_texture_vectors",
        },
      },
      quality_assurance_and_fallback: {
        amdec_failure_modes: {
          ai_hallucination_detected: {
            trigger_condition: "structural_similarity < threshold",
            action: "rollback_to_base_stream",
            fallback_filter: "Lanczos3",
          },
          hardware_timeout: {
            trigger_condition: "inference_time_ms > 150",
            action: "downgrade_ai_model",
            fallback_model: "SwinIR_Fast_Light",
            implemented_fallback_model: AI_MODEL_PRESETS["mobile-x2"].label,
          },
        },
      },
      advanced_dimensional_control: {
        global_metrics: {
          ssim_minimum: DEFAULT_AURA_QUALITY_RULES.ssimMinimum,
          psnr_target_db: DEFAULT_AURA_QUALITY_RULES.psnrTargetDb,
        },
        geometric_tolerances: [
          {
            roi_name: "facial_features",
            semantic_class: "skin",
            max_edge_displacement_pixels: DEFAULT_AURA_QUALITY_RULES.facialEdgeDisplacementPx,
            enforcement: "critical",
          },
          {
            roi_name: "architectural_lines",
            semantic_class: "architecture",
            max_edge_displacement_pixels: DEFAULT_AURA_QUALITY_RULES.architecturalEdgeDisplacementPx,
            straightness_preservation_index: DEFAULT_AURA_QUALITY_RULES.straightnessPreservationIndex,
            enforcement: "critical",
          },
        ],
      },
      hardware_execution_directives: {
        preferred_compute_unit: "NPU",
        memory_footprint_limit_mb: DEFAULT_AURA_QUALITY_RULES.memoryFootprintLimitMb,
        quantization_fallback_allowed: true,
        browser_compute_note:
          "Le navigateur ne fournit pas d'API NPU générique ici ; ONNX Runtime utilise WebGPU puis WASM selon disponibilité.",
      },
      provenance_and_security: {
        c2pa_manifest: {
          assertion_type: "c2pa.actions.ai_enhanced",
          base_image_hash: baseHash,
          ai_generation_ratio_percent: 0,
          signature_authority: "Vision-IA Encoder Core",
          signed: false,
          note:
            "Assertion de provenance AV-1X non signée. Ce bloc n'est pas un manifeste C2PA cryptographiquement valide.",
        },
      },
      implementation_status: {
        learned_vae: false,
        cabac: false,
        native_10bit_hdr: false,
        isobmff: false,
        note: "AV-1X v1.0 navigateur formalise le manifeste cible sans prétendre implémenter les blocs encore absents.",
      },
    };

    const metadata = new TextEncoder().encode(JSON.stringify(manifest));
    const total =
      HEADER_BYTES +
      baseBytes.byteLength +
      semanticRle.byteLength +
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
    writeU32(view, 36, semanticRle.byteLength);
    writeU32(view, 40, maps.latent.byteLength);
    writeU32(view, 44, metadata.byteLength);

    let offset = HEADER_BYTES;
    output.set(baseBytes, offset);
    offset += baseBytes.byteLength;
    output.set(semanticRle, offset);
    offset += semanticRle.byteLength;
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
      semanticBytes: semanticRle.byteLength,
      latentBytes: maps.latent.byteLength,
      ratioVsRgba: blob.size / Math.max(1, decoded.width * decoded.height * 4),
      semanticSummary: semanticSummary(maps.semantic),
      manifest,
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
  metadata: AuraVisionManifest | null;
  integrityVerified: boolean | null;
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
  const semanticCompressed = bytes.slice(offset, offset + semanticLength);
  offset += semanticLength;
  const latent = bytes.slice(offset, offset + latentLength);
  offset += latentLength;
  const metadataBytes = bytes.slice(offset, offset + metadataLength);

  let metadata: AuraVisionManifest | null = null;
  try {
    const parsedMetadata = JSON.parse(new TextDecoder().decode(metadataBytes)) as AuraVisionManifest;
    if (parsedMetadata?.header?.magic_identifier === MAGIC_IDENTIFIER) metadata = parsedMetadata;
  } catch {
    metadata = null;
  }

  let integrityVerified: boolean | null = null;
  if (metadata?.dimensional_control?.cryptographic_validation?.reference_hash_sha256) {
    const actualHash = await sha256Hex([
      bytes.slice(HEADER_BYTES, HEADER_BYTES + baseLength),
      semanticCompressed,
      latent,
    ]);
    integrityVerified =
      actualHash === metadata.dimensional_control.cryptographic_validation.reference_hash_sha256;
    if (!integrityVerified) {
      throw new Error("Échec d'intégrité AV-1X : empreinte SHA-256 du payload invalide.");
    }
  }

  const semantic =
    metadata?.data_streams?.ai_enhancement_payload?.semantic_segmentation?.map_encoding === "RLE_compressed"
      ? rleDecode(semanticCompressed, gridW * gridH)
      : semanticCompressed;

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
    integrityVerified,
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
  blendScale = 1,
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
      ctx.globalAlpha =
        semanticBlendAlpha(semantic[index] ?? 0, latent, index) *
        clamp(blendScale, 0, 1);
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

    const baseCanvas = document.createElement("canvas");
    baseCanvas.width = parsed.baseWidth;
    baseCanvas.height = parsed.baseHeight;
    const baseCtx = baseCanvas.getContext("2d");
    if (!baseCtx) throw new Error("Canvas du flux structurel AV-1X indisponible.");
    baseCtx.drawImage(baseDecoded.source, 0, 0, parsed.baseWidth, parsed.baseHeight);

    onProgress?.(0.14, "Aura-Vision · reconstruction Lanczos3 sécurisée");
    const deterministic = lanczos3Resample(baseCanvas, width, height);

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
    let qualityReport: AuraQualityReport | null = null;
    let inferenceTimeMs: number | null = null;
    let modelDowngraded = false;
    let fallbackFilter: "Lanczos3" | null = null;
    let actualComputeUnit = "deterministic";
    let aiGenerationRatioPercent = 0;

    let model = loadedModel();
    const memoryEstimate = estimateAuraMemoryMb(width, height);
    if (
      useAi &&
      model &&
      memoryEstimate <= DEFAULT_AURA_QUALITY_RULES.memoryFootprintLimitMb
    ) {
      onProgress?.(0.30, `Aura-Vision · IA locale ${model.provider.toUpperCase()} x${model.scale}`);
      try {
        const runInference = async () => {
          const started = performance.now();
          const output = await upscaleWithAi(
            baseCanvas,
            (ratio, label) => {
              onProgress?.(0.30 + ratio * 0.32, label);
            },
            {
              targetWidth: width,
              targetHeight: height,
              allowRuntimeFallback: true,
            },
          );
          return { output, elapsed: performance.now() - started };
        };

        let inference = await runInference();
        inferenceTimeMs = inference.elapsed;

        if (
          inference.elapsed > DEFAULT_AURA_QUALITY_RULES.inferenceTimeoutMs &&
          model.scale > 2.1
        ) {
          inference.output.width = 1;
          inference.output.height = 1;
          onProgress?.(
            0.48,
            `AMDEC · ${Math.round(inference.elapsed)} ms > ${DEFAULT_AURA_QUALITY_RULES.inferenceTimeoutMs} ms · repli modèle léger`,
          );
          const fallback = AI_MODEL_PRESETS["mobile-x2"];
          await loadAiModel({
            kind: "url",
            url: fallback.url,
            label: fallback.label,
          });
          model = loadedModel();
          if (!model) throw new Error("Le modèle IA léger n'a pas pu être chargé.");
          modelDowngraded = true;
          inference = await runInference();
          inferenceTimeMs = inference.elapsed;
        }

        const neuralRaw = inference.output;
        const neural = document.createElement("canvas");
        neural.width = width;
        neural.height = height;
        const neuralCtx = neural.getContext("2d");
        if (!neuralCtx) throw new Error("Canvas neuronal final indisponible.");
        neuralCtx.imageSmoothingEnabled = true;
        neuralCtx.imageSmoothingQuality = "high";
        neuralCtx.drawImage(neuralRaw, 0, 0, width, height);

        onProgress?.(0.68, "Aura-Vision · Quality Gate AMDEC");
        qualityReport = validateAuraGeneration(
          deterministic,
          neural,
          parsed.semantic,
          parsed.gridW,
          parsed.gridH,
          {
            ...DEFAULT_AURA_QUALITY_RULES,
            ssimMinimum: Math.max(
              structuralThreshold,
              parsed.metadata?.advanced_dimensional_control?.global_metrics?.ssim_minimum ??
                DEFAULT_AURA_QUALITY_RULES.ssimMinimum,
            ),
            psnrTargetDb:
              parsed.metadata?.advanced_dimensional_control?.global_metrics?.psnr_target_db ??
              DEFAULT_AURA_QUALITY_RULES.psnrTargetDb,
          },
        );
        structuralSsim = qualityReport.ssim;

        if (qualityReport.accepted) {
          onProgress?.(
            0.82,
            qualityReport.decision === "blend"
              ? "Aura-Vision · fusion IA réduite validée"
              : "Aura-Vision · fusion sémantique validée",
          );
          finalCanvas = compositeSemanticGuide(
            deterministic,
            neural,
            parsed.semantic,
            parsed.latent,
            parsed.gridW,
            parsed.gridH,
            qualityReport.blendStrength,
          );
          usedAi = true;
          actualComputeUnit = model?.provider?.toUpperCase() ?? "ONNX";
          let alphaSum = 0;
          for (let i = 0; i < parsed.semantic.length; i += 1) {
            alphaSum +=
              semanticBlendAlpha(parsed.semantic[i] ?? 0, parsed.latent, i) *
              qualityReport.blendStrength;
          }
          aiGenerationRatioPercent =
            parsed.semantic.length ? alphaSum / parsed.semantic.length * 100 : 0;
          if (qualityReport.decision === "blend") {
            fallbackReason =
              `AMDEC : métriques globales sous la cible, IA conservée à ${Math.round(qualityReport.blendStrength * 100)} % après validation géométrique.`;
          }
        } else {
          fallbackFilter = "Lanczos3";
          fallbackReason =
            "AMDEC : " + qualityReport.failures.join(" ; ") +
            ". Rollback vers le flux structurel Lanczos3.";
        }

        neuralRaw.width = 1;
        neuralRaw.height = 1;
        neural.width = 1;
        neural.height = 1;
      } catch (reason) {
        if (isCancelledError(reason)) throw reason;
        fallbackFilter = "Lanczos3";
        fallbackReason =
          "Reconstruction neuronale indisponible : " +
          (reason instanceof Error ? reason.message : "raison inconnue") +
          ". Repli Lanczos3.";
      }
    } else if (useAi && !model) {
      fallbackFilter = "Lanczos3";
      fallbackReason = "Aucun modèle ONNX chargé : reconstruction déterministe Lanczos3.";
    } else if (
      useAi &&
      model &&
      memoryEstimate > DEFAULT_AURA_QUALITY_RULES.memoryFootprintLimitMb
    ) {
      fallbackFilter = "Lanczos3";
      fallbackReason =
        `AMDEC mémoire : ${memoryEstimate.toFixed(0)} Mo estimés > ${DEFAULT_AURA_QUALITY_RULES.memoryFootprintLimitMb} Mo. Repli Lanczos3.`;
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
    baseCanvas.width = 1;
    baseCanvas.height = 1;

    return {
      blob: outputBlob,
      width,
      height,
      usedAi,
      structuralSsim,
      fallbackReason,
      semanticSummary: semanticSummary(parsed.semantic),
      manifest: parsed.metadata,
      qualityReport,
      inferenceTimeMs,
      modelDowngraded,
      fallbackFilter,
      actualComputeUnit,
      integrityVerified: parsed.integrityVerified,
      aiGenerationRatioPercent,
    };
  } finally {
    baseDecoded.close();
  }
}
