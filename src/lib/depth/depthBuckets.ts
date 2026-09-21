import {
  MAX_DEPTH_PLANES,
  MIN_DEPTH_PLANES,
  sanitizeDepthFocusSettings,
  type DepthBucket,
  type DepthFocusSettings,
} from "./depthTypes";

export function buildDepthBuckets(settings: DepthFocusSettings): DepthBucket[] {
  const safe = sanitizeDepthFocusSettings(settings);
  const planes = Math.max(MIN_DEPTH_PLANES, Math.min(MAX_DEPTH_PLANES, safe.planes));
  const buckets: DepthBucket[] = [];

  for (let i = 0; i < planes; i += 1) {
    const near = i / planes;
    const far = (i + 1) / planes;
    const t = i / Math.max(1, planes - 1);
    const proximity = 1 - t;

    buckets.push({
      id: i,
      near,
      far,
      // Tous les plans restent traités ; le fond est simplement plus prudent.
      strength: safe.globalStrength * (0.68 + proximity * 0.32),
      deblur: 0.16 + proximity * 0.28,
      edgeBoost: 0.24 + proximity * 0.38,
      noiseProtection: 0.54 + t * 0.30,
      confidenceBias: 0.58 + proximity * 0.24,
    });
  }

  return buckets;
}
