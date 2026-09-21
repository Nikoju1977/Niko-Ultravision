export type DepthFocusMode = "heuristic";

export interface DepthMap {
  width: number;
  height: number;
  values: Float32Array;
}

export interface DepthEstimate {
  depth: DepthMap;
  structure: DepthMap;
}

export interface DepthConfidenceMap {
  width: number;
  height: number;
  values: Float32Array;
}

export interface DepthBucket {
  id: number;
  near: number;
  far: number;
  strength: number;
  deblur: number;
  edgeBoost: number;
  noiseProtection: number;
  confidenceBias: number;
}

export interface DepthFocusSettings {
  enabled: boolean;
  mode: DepthFocusMode;
  planes: number;
  globalStrength: number;
  confidenceGate: number;
  fusionFeather: number;
  centerBias: number;
}

export interface DepthFocusReport {
  applied: boolean;
  planes: number;
  meanConfidence: number;
  processedCoverage: number;
  nearCoverage: number;
  midCoverage: number;
  farCoverage: number;
  meanCorrection: number;
  skippedReason?: string;
}

export const MIN_DEPTH_PLANES = 10;
export const MAX_DEPTH_PLANES = 16;
export const DEPTH_FOCUS_MAX_PIXELS = 8_000_000;

export const DEFAULT_DEPTH_FOCUS: DepthFocusSettings = {
  enabled: true,
  mode: "heuristic",
  planes: 12,
  globalStrength: 0.56,
  confidenceGate: 0.30,
  fusionFeather: 0.42,
  centerBias: 0.34,
};

export function sanitizeDepthFocusSettings(settings: DepthFocusSettings): DepthFocusSettings {
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
  return {
    enabled: Boolean(settings.enabled),
    mode: "heuristic",
    planes: Math.round(clamp(settings.planes, MIN_DEPTH_PLANES, MAX_DEPTH_PLANES)),
    globalStrength: clamp(settings.globalStrength, 0, 1),
    confidenceGate: clamp(settings.confidenceGate, 0, 0.95),
    fusionFeather: clamp(settings.fusionFeather, 0, 1),
    centerBias: clamp(settings.centerBias, 0, 1),
  };
}
