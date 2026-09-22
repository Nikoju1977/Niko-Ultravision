export type VisionCanvas = HTMLCanvasElement | OffscreenCanvas;

export interface ZoneMetrics {
  zoneId: number;
  row: number;
  col: number;
  sharpness: number;
  microContrast: number;
  noise: number;
  haloRisk: number;
  blockiness: number;
  meanLuma: number;
  contrast: number;
  clippedBlack: number;
  clippedWhite: number;
}

export interface FrameMetrics {
  timestamp: number;
  meanLuma: number;
  contrast: number;
  detailEnergy: number;
  noise: number;
  haloRisk: number;
  blockiness: number;
  clippedBlack: number;
  clippedWhite: number;
  zones: ZoneMetrics[];
}

export interface VideoVisionMetrics {
  frameCountAnalyzed: number;
  meanLuma: number;
  contrast: number;
  detailEnergy: number;
  noise: number;
  haloRisk: number;
  blockiness: number;
  clippedBlack: number;
  clippedWhite: number;
  weakestZones: number[];
  strongestZones: number[];
  zones: ZoneMetrics[];
  frames: FrameMetrics[];
}

export interface ZoneRect {
  zoneId: number;
  row: number;
  col: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PixelMetrics {
  meanLuma: number;
  contrast: number;
  sharpness: number;
  microContrast: number;
  noise: number;
  haloRisk: number;
  blockiness: number;
  clippedBlack: number;
  clippedWhite: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function buildLuma(data: Uint8ClampedArray): Float32Array {
  const values = new Float32Array(Math.max(1, Math.floor(data.length / 4)));
  for (let i = 0, p = 0; i + 2 < data.length; i += 4, p += 1) {
    values[p] = luma(data[i], data[i + 1], data[i + 2]);
  }
  return values;
}

function analyzePixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): PixelMetrics {
  const count = Math.max(1, width * height);
  const values = buildLuma(data);

  let sum = 0;
  let black = 0;
  let white = 0;

  for (let i = 0; i < count; i += 1) {
    const value = values[i] ?? 0;
    sum += value;
    if (value <= 8) black += 1;
    if (value >= 247) white += 1;
  }

  const mean = sum / count;
  let variance = 0;
  let gradientSum = 0;
  let gradientCount = 0;
  let localResidual = 0;
  let residualCount = 0;
  let strongEdges = 0;
  let extremeEdges = 0;

  let blockEnergy = 0;
  let blockCount = 0;
  let normalEnergy = 0;
  let normalCount = 0;

  const at = (x: number, y: number): number => values[y * width + x] ?? 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const current = at(x, y);
      const delta = current - mean;
      variance += delta * delta;

      if (x + 1 < width) {
        const edge = Math.abs(current - at(x + 1, y));
        gradientSum += edge;
        gradientCount += 1;
        if (edge > 20) strongEdges += 1;
        if (edge > 60) extremeEdges += 1;

        if ((x + 1) % 8 === 0) {
          blockEnergy += edge;
          blockCount += 1;
        } else {
          normalEnergy += edge;
          normalCount += 1;
        }
      }

      if (y + 1 < height) {
        const edge = Math.abs(current - at(x, y + 1));
        gradientSum += edge;
        gradientCount += 1;
        if (edge > 20) strongEdges += 1;
        if (edge > 60) extremeEdges += 1;

        if ((y + 1) % 8 === 0) {
          blockEnergy += edge;
          blockCount += 1;
        } else {
          normalEnergy += edge;
          normalCount += 1;
        }
      }

      if (x > 0 && x + 1 < width && y > 0 && y + 1 < height) {
        const neighborMean =
          (at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1)) / 4;
        localResidual += Math.abs(current - neighborMean);
        residualCount += 1;
      }
    }
  }

  const contrast = Math.sqrt(variance / count) / 128;
  const sharpness = gradientCount ? gradientSum / gradientCount / 255 : 0;
  const noise = residualCount ? localResidual / residualCount / 255 : 0;
  const haloRisk = strongEdges ? extremeEdges / strongEdges : 0;

  const blockMean = blockCount ? blockEnergy / blockCount : 0;
  const normalMean = normalCount ? normalEnergy / normalCount : 0;
  const blockiness = normalMean > 0 ? Math.max(0, blockMean - normalMean) / 255 : 0;

  return {
    meanLuma: clamp01(mean / 255),
    contrast: clamp01(contrast),
    sharpness: clamp01(sharpness),
    microContrast: clamp01(sharpness * 0.72 + contrast * 0.28),
    noise: clamp01(noise),
    haloRisk: clamp01(haloRisk),
    blockiness: clamp01(blockiness),
    clippedBlack: clamp01(black / count),
    clippedWhite: clamp01(white / count),
  };
}

export function getZoneRects(width: number, height: number): ZoneRect[] {
  const cols = 5;
  const rows = 2;
  const zones: ZoneRect[] = [];
  let zoneId = 0;

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x = Math.floor((col * width) / cols);
      const y = Math.floor((row * height) / rows);
      const nextX = Math.floor(((col + 1) * width) / cols);
      const nextY = Math.floor(((row + 1) * height) / rows);

      zones.push({
        zoneId,
        row,
        col,
        x,
        y,
        width: Math.max(1, nextX - x),
        height: Math.max(1, nextY - y),
      });
      zoneId += 1;
    }
  }

  return zones;
}

export function analyzeVisionCanvas(
  canvas: VisionCanvas,
  timestamp = 0,
): FrameMetrics {
  const ctx = canvas.getContext("2d", { willReadFrequently: true }) as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error("Canvas 2D indisponible pour Agent Vision.");

  const width = canvas.width;
  const height = canvas.height;
  if (width < 2 || height < 2) {
    throw new Error("Frame trop petite pour Agent Vision.");
  }

  const full = ctx.getImageData(0, 0, width, height);
  const global = analyzePixels(full.data, width, height);

  const zones = getZoneRects(width, height).map((zone) => {
    const image = ctx.getImageData(zone.x, zone.y, zone.width, zone.height);
    const metrics = analyzePixels(image.data, zone.width, zone.height);
    return {
      zoneId: zone.zoneId,
      row: zone.row,
      col: zone.col,
      sharpness: metrics.sharpness,
      microContrast: metrics.microContrast,
      noise: metrics.noise,
      haloRisk: metrics.haloRisk,
      blockiness: metrics.blockiness,
      meanLuma: metrics.meanLuma,
      contrast: metrics.contrast,
      clippedBlack: metrics.clippedBlack,
      clippedWhite: metrics.clippedWhite,
    };
  });

  return {
    timestamp,
    meanLuma: global.meanLuma,
    contrast: global.contrast,
    detailEnergy: global.sharpness,
    noise: global.noise,
    haloRisk: global.haloRisk,
    blockiness: global.blockiness,
    clippedBlack: global.clippedBlack,
    clippedWhite: global.clippedWhite,
    zones,
  };
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function averageZones(frames: FrameMetrics[]): ZoneMetrics[] {
  return Array.from({ length: 10 }, (_, zoneId) => {
    const matches = frames
      .map((frame) => frame.zones.find((zone) => zone.zoneId === zoneId))
      .filter((zone): zone is ZoneMetrics => Boolean(zone));

    const first = matches[0];
    return {
      zoneId,
      row: first?.row ?? Math.floor(zoneId / 5),
      col: first?.col ?? zoneId % 5,
      sharpness: average(matches.map((zone) => zone.sharpness)),
      microContrast: average(matches.map((zone) => zone.microContrast)),
      noise: average(matches.map((zone) => zone.noise)),
      haloRisk: average(matches.map((zone) => zone.haloRisk)),
      blockiness: average(matches.map((zone) => zone.blockiness)),
      meanLuma: average(matches.map((zone) => zone.meanLuma)),
      contrast: average(matches.map((zone) => zone.contrast)),
      clippedBlack: average(matches.map((zone) => zone.clippedBlack)),
      clippedWhite: average(matches.map((zone) => zone.clippedWhite)),
    };
  });
}

export function aggregateVisionFrames(frames: FrameMetrics[]): VideoVisionMetrics | null {
  if (!frames.length) return null;

  const zones = averageZones(frames);
  const bySharpness = [...zones].sort((a, b) => a.sharpness - b.sharpness);

  return {
    frameCountAnalyzed: frames.length,
    meanLuma: average(frames.map((frame) => frame.meanLuma)),
    contrast: average(frames.map((frame) => frame.contrast)),
    detailEnergy: average(frames.map((frame) => frame.detailEnergy)),
    noise: average(frames.map((frame) => frame.noise)),
    haloRisk: average(frames.map((frame) => frame.haloRisk)),
    blockiness: average(frames.map((frame) => frame.blockiness)),
    clippedBlack: average(frames.map((frame) => frame.clippedBlack)),
    clippedWhite: average(frames.map((frame) => frame.clippedWhite)),
    weakestZones: bySharpness.slice(0, 3).map((zone) => zone.zoneId + 1),
    strongestZones: bySharpness.slice(-3).reverse().map((zone) => zone.zoneId + 1),
    zones,
    frames,
  };
}
