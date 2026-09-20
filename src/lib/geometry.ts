export type TargetId = "original" | "1080p" | "2k" | "4k" | "8k" | "16k";

export const TARGET_LONG_SIDE: Record<TargetId, number | null> = {
  original: null,
  "1080p": 1920,
  "2k": 2048,
  "4k": 3840,
  "8k": 7680,
  "16k": 15360,
};

export interface Size {
  width: number;
  height: number;
}

export function calculateOutputSize(width: number, height: number, target: TargetId): Size {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("Dimensions source invalides.");
  }

  const longSide = TARGET_LONG_SIDE[target];
  if (!longSide) return { width: Math.round(width), height: Math.round(height) };

  const scale = longSide / Math.max(width, height);
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

  return {
    width: even(width * scale),
    height: even(height * scale),
  };
}

export function formatDimensions(size: Size | null): string {
  if (!size) return "—";
  return `${size.width.toLocaleString("fr-FR")} × ${size.height.toLocaleString("fr-FR")}`;
}

export function megapixels(size: Size | null): number {
  if (!size) return 0;
  return (size.width * size.height) / 1_000_000;
}

export function sameAspectRatio(a: Size, b: Size, tolerance = 0.0005): boolean {
  return Math.abs(a.width / a.height - b.width / b.height) <= tolerance;
}
