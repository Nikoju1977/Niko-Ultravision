/**
 * Finition naturelle des masters IA.
 *
 * Les super-résolutions (Real-ESRGAN, Swin2SR) suppriment le bruit et les blocs
 * JPEG, mais effacent aussi toute micro-texture : la peau prend un aspect
 * « cire » / plastique. La pratique professionnelle consiste à réintroduire un
 * grain photographique fin, uniquement dans les zones lisses. Le grain n'ajoute
 * aucune structure (ni contour, ni forme) : c'est une texture aléatoire de très
 * faible amplitude, déterministe (même image → même résultat).
 */
import { decodeImageFile } from "../imageDecode";
import { canvas2d } from "./imageMath";

export interface NaturalFinishOptions {
  /** Écart-type du grain en niveaux 0–255 (défaut 1,8). */
  amplitude?: number;
  onProgress?: (ratio: number) => void;
}

const BAND = 128;
const HALO = 6;

/** Bruit blanc déterministe ~N(0,1) à partir des coordonnées. */
function hashNoise(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  const u1 = ((h >>> 0) & 0xffff) / 65536 + 1 / 131072;
  const u2 = ((h >>> 16) & 0xffff) / 65536;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export async function applyNaturalFinish(
  master: Blob,
  format: string,
  options: NaturalFinishOptions = {},
): Promise<Blob> {
  const amplitude = options.amplitude ?? 1.8;
  const decoded = await decodeImageFile(master);
  const width = decoded.width;
  const height = decoded.height;
  const { canvas, ctx } = canvas2d(width, height);
  try {
    ctx.drawImage(decoded.source, 0, 0);
  } finally {
    decoded.close();
  }

  // Grain légèrement corrélé : bruit blanc lissé par un noyau binomial 3×3,
  // renormalisé à un écart-type 1 (somme des carrés du noyau = 36/256).
  const norm = 1 / Math.sqrt(36 / 256);

  for (let y0 = 0; y0 < height; y0 += BAND) {
    const top = Math.max(0, y0 - HALO);
    const bottom = Math.min(height, y0 + BAND + HALO);
    const bandHeight = bottom - top;
    const image = ctx.getImageData(0, top, width, bandHeight);
    const px = image.data;

    // Luminance de la bande (avec halo).
    const luma = new Float32Array(width * bandHeight);
    for (let i = 0, p = 0; p < luma.length; i += 4, p += 1) {
      luma[p] = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    }

    // Gradient (différences centrales) puis moyenne locale 9×9 via intégrale.
    const grad = new Float32Array(width * bandHeight);
    for (let r = 1; r < bandHeight - 1; r += 1) {
      for (let c = 1; c < width - 1; c += 1) {
        const i = r * width + c;
        const gx = luma[i + 1] - luma[i - 1];
        const gy = luma[i + width] - luma[i - width];
        grad[i] = Math.sqrt(gx * gx + gy * gy) * 0.5;
      }
    }
    const integral = new Float64Array((width + 1) * (bandHeight + 1));
    for (let r = 0; r < bandHeight; r += 1) {
      let rowSum = 0;
      for (let c = 0; c < width; c += 1) {
        rowSum += grad[r * width + c];
        integral[(r + 1) * (width + 1) + c + 1] = integral[r * (width + 1) + c + 1] + rowSum;
      }
    }
    const boxMean = (r: number, c: number) => {
      const r0 = Math.max(0, r - 4), r1 = Math.min(bandHeight - 1, r + 4);
      const c0 = Math.max(0, c - 4), c1 = Math.min(width - 1, c + 4);
      const sum =
        integral[(r1 + 1) * (width + 1) + c1 + 1] -
        integral[r0 * (width + 1) + c1 + 1] -
        integral[(r1 + 1) * (width + 1) + c0] +
        integral[r0 * (width + 1) + c0];
      return sum / ((r1 - r0 + 1) * (c1 - c0 + 1));
    };

    // Bruit blanc de la bande, calculé une seule fois par pixel.
    const white = new Float32Array(width * bandHeight);
    for (let r = 0; r < bandHeight; r += 1) {
      for (let c = 0; c < width; c += 1) white[r * width + c] = hashNoise(c, top + r);
    }

    const start = y0 - top;
    const end = Math.min(bandHeight, start + BAND);
    for (let r = start; r < end; r += 1) {
      for (let c = 0; c < width; c += 1) {
        const i = r * width + c;
        // Zones lisses uniquement : aucun grain sur les contours et textures.
        const smooth = 1 - Math.min(1, Math.max(0, (boxMean(r, c) - 1.5) / 4));
        if (smooth <= 0.02) continue;
        // Moins de grain dans les noirs profonds et les hautes lumières.
        const mid = Math.max(0.25, 1 - Math.abs(luma[i] - 128) / 128);
        let n = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          const rr = Math.min(bandHeight - 1, Math.max(0, r + dy));
          for (let dx = -1; dx <= 1; dx += 1) {
            const cc = Math.min(width - 1, Math.max(0, c + dx));
            n += (dy === 0 ? 2 : 1) * (dx === 0 ? 2 : 1) * white[rr * width + cc];
          }
        }
        const delta = amplitude * smooth * mid * (n / 16) * norm;
        const o = i * 4;
        px[o] += delta;
        px[o + 1] += delta;
        px[o + 2] += delta;
      }
    }
    // On ne réécrit que le cœur de bande (sans halo).
    ctx.putImageData(image, 0, top, 0, start, width, end - start);
    options.onProgress?.(Math.min(1, (y0 + BAND) / height));
    // Rend la main à l'interface entre deux bandes.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  const type = format === "image/jpeg" || format === "image/webp" ? format : "image/png";
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) => (value ? resolve(value) : reject(new Error("Encodage de la finition impossible."))),
      type,
      0.95,
    ),
  );
  canvas.width = 1;
  canvas.height = 1;
  return blob;
}
