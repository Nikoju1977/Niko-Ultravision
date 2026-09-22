/** Outils numériques communs au diagnostic et au contrôle qualité. */

export interface Luma {
  data: Float32Array;
  width: number;
  height: number;
}

export function canvas2d(width: number, height: number): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas 2D indisponible.");
  return { canvas, ctx };
}

/** Rééchantillonnage haute qualité du navigateur (réduction : moyenne de zone). */
export function resample(
  source: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  width: number,
  height: number,
): HTMLCanvasElement {
  const { canvas, ctx } = canvas2d(width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Luminance Rec.709, en unités 0–255. */
export function lumaOf(canvas: HTMLCanvasElement): Luma {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas 2D indisponible.");
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const out = new Float32Array(canvas.width * canvas.height);
  for (let i = 0, p = 0; p < out.length; i += 4, p += 1) {
    out[p] = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  }
  return { data: out, width: canvas.width, height: canvas.height };
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Variance du laplacien : mesure de netteté classique. */
export function laplacianVariance(y: Luma): number {
  const { data, width, height } = y;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let r = 1; r < height - 1; r += 1) {
    for (let c = 1; c < width - 1; c += 1) {
      const i = r * width + c;
      const v = 4 * data[i] - data[i - 1] - data[i + 1] - data[i - width] - data[i + width];
      sum += v;
      sumSq += v * v;
      n += 1;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/**
 * Estimation du bruit (méthode d'Immerkær, 1996) : écart-type du bruit gaussien
 * en unités 0–255, robuste aux structures grâce au masque de différence
 * seconde.
 */
export function noiseSigma(y: Luma): number {
  const { data, width, height } = y;
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  for (let r = 1; r < height - 1; r += 1) {
    for (let c = 1; c < width - 1; c += 1) {
      const i = r * width + c;
      const v =
        data[i - width - 1] - 2 * data[i - width] + data[i - width + 1] -
        2 * data[i - 1] + 4 * data[i] - 2 * data[i + 1] +
        data[i + width - 1] - 2 * data[i + width] + data[i + width + 1];
      sum += Math.abs(v);
    }
  }
  return Math.sqrt(Math.PI / 2) * sum / (6 * (width - 2) * (height - 2));
}

/** Énergie moyenne du gradient (Sobel simplifié). */
export function gradientEnergy(y: Luma): number {
  const { data, width, height } = y;
  let sum = 0;
  let n = 0;
  for (let r = 1; r < height - 1; r += 1) {
    for (let c = 1; c < width - 1; c += 1) {
      const i = r * width + c;
      const gx = data[i + 1] - data[i - 1];
      const gy = data[i + width] - data[i - width];
      sum += Math.sqrt(gx * gx + gy * gy);
      n += 1;
    }
  }
  return n ? sum / n : 0;
}

/**
 * Blocs JPEG : rapport entre les discontinuités aux frontières de grille 8×8
 * et celles à l'intérieur des blocs. ≈1 sans artefact, >1,3 blocs visibles.
 */
export function jpegBlockiness(y: Luma): number {
  const { data, width, height } = y;
  let boundary = 0;
  let inner = 0;
  let nb = 0;
  let ni = 0;
  for (let r = 0; r < height; r += 1) {
    for (let c = 1; c < width; c += 1) {
      const d = Math.abs(data[r * width + c] - data[r * width + c - 1]);
      if (c % 8 === 0) { boundary += d; nb += 1; } else { inner += d; ni += 1; }
    }
  }
  for (let r = 1; r < height; r += 1) {
    for (let c = 0; c < width; c += 1) {
      const d = Math.abs(data[r * width + c] - data[(r - 1) * width + c]);
      if (r % 8 === 0) { boundary += d; nb += 1; } else { inner += d; ni += 1; }
    }
  }
  if (!nb || !ni) return 1;
  return (boundary / nb) / Math.max(0.5, inner / ni);
}

/** SSIM moyen sur fenêtres 8×8 (pas de 4), luminance 0–255. */
export function ssim(a: Luma, b: Luma): number {
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  let total = 0;
  let count = 0;
  for (let y0 = 0; y0 + 8 <= height; y0 += 4) {
    for (let x0 = 0; x0 + 8 <= width; x0 += 4) {
      let ma = 0, mb = 0;
      for (let y = y0; y < y0 + 8; y += 1) {
        for (let x = x0; x < x0 + 8; x += 1) {
          ma += a.data[y * a.width + x];
          mb += b.data[y * b.width + x];
        }
      }
      ma /= 64; mb /= 64;
      let va = 0, vb = 0, cov = 0;
      for (let y = y0; y < y0 + 8; y += 1) {
        for (let x = x0; x < x0 + 8; x += 1) {
          const da = a.data[y * a.width + x] - ma;
          const db = b.data[y * b.width + x] - mb;
          va += da * da; vb += db * db; cov += da * db;
        }
      }
      va /= 63; vb /= 63; cov /= 63;
      total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      count += 1;
    }
  }
  return count ? total / count : 1;
}

export function psnr(a: Luma, b: Luma): number {
  const n = Math.min(a.data.length, b.data.length);
  let mse = 0;
  for (let i = 0; i < n; i += 1) {
    const d = a.data[i] - b.data[i];
    mse += d * d;
  }
  mse /= Math.max(1, n);
  return mse <= 1e-9 ? 99 : 10 * Math.log10((255 * 255) / mse);
}

/** Erreur locale maximale (p99 des RMSE par blocs 8×8) : détecte les hallucinations localisées. */
export function localErrorP99(a: Luma, b: Luma): number {
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  const errors: number[] = [];
  for (let y0 = 0; y0 + 8 <= height; y0 += 8) {
    for (let x0 = 0; x0 + 8 <= width; x0 += 8) {
      let mse = 0;
      for (let y = y0; y < y0 + 8; y += 1) {
        for (let x = x0; x < x0 + 8; x += 1) {
          const d = a.data[y * a.width + x] - b.data[y * b.width + x];
          mse += d * d;
        }
      }
      errors.push(Math.sqrt(mse / 64));
    }
  }
  if (!errors.length) return 0;
  errors.sort((p, q) => p - q);
  return errors[Math.min(errors.length - 1, Math.floor(errors.length * 0.99))];
}

/**
 * Ringing / halos : part des pixels proches des contours forts de la
 * référence où le candidat dépasse l'enveloppe locale (min/max 3×3) de la
 * référence de plus de `tolerance`.
 */
export function ringingRatio(candidate: Luma, reference: Luma, tolerance = 10): number {
  const { width, height } = reference;
  const ref = reference.data;
  const cand = candidate.data;
  let edgeZone = 0;
  let overshoot = 0;
  for (let r = 2; r < height - 2; r += 1) {
    for (let c = 2; c < width - 2; c += 1) {
      const i = r * width + c;
      const gx = ref[i + 2] - ref[i - 2];
      const gy = ref[i + 2 * width] - ref[i - 2 * width];
      if (Math.abs(gx) + Math.abs(gy) < 40) continue;
      let lo = 255, hi = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const v = ref[i + dy * width + dx];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      edgeZone += 1;
      const v = cand[i];
      if (v > hi + tolerance || v < lo - tolerance) overshoot += 1;
    }
  }
  return edgeZone ? overshoot / edgeZone : 0;
}

/**
 * Accentuation classique (unsharp mask) sur un canvas, en place. Flou
 * binomial 3×3 calculé en JS : résultat identique sur tous les navigateurs
 * (ctx.filter n'est pas fiable partout).
 */
export function unsharpMask(canvas: HTMLCanvasElement, amount: number, threshold = 2): void {
  if (amount <= 0) return;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;
  const { width, height } = canvas;
  const image = ctx.getImageData(0, 0, width, height);
  const px = image.data;
  const src = new Uint8ClampedArray(px);
  const k = [1, 2, 1];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      for (let ch = 0; ch < 3; ch += 1) {
        let acc = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          const yy = Math.min(height - 1, Math.max(0, y + dy));
          for (let dx = -1; dx <= 1; dx += 1) {
            const xx = Math.min(width - 1, Math.max(0, x + dx));
            acc += k[dy + 1] * k[dx + 1] * src[(yy * width + xx) * 4 + ch];
          }
        }
        const detail = src[o + ch] - acc / 16;
        if (Math.abs(detail) > threshold) px[o + ch] = src[o + ch] + amount * detail;
      }
    }
  }
  ctx.putImageData(image, 0, 0);
}

/** Lissage binomial 3×3 d'un canvas (débruitage classique léger), nouvelle copie. */
export function smoothCanvas(source: HTMLCanvasElement, passes = 1): HTMLCanvasElement {
  const { canvas, ctx } = canvas2d(source.width, source.height);
  ctx.drawImage(source, 0, 0);
  const { width, height } = canvas;
  const image = ctx.getImageData(0, 0, width, height);
  const px = image.data;
  const k = [1, 2, 1];
  for (let pass = 0; pass < passes; pass += 1) {
    const src = new Uint8ClampedArray(px);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const o = (y * width + x) * 4;
        for (let ch = 0; ch < 3; ch += 1) {
          let acc = 0;
          for (let dy = -1; dy <= 1; dy += 1) {
            const yy = Math.min(height - 1, Math.max(0, y + dy));
            for (let dx = -1; dx <= 1; dx += 1) {
              const xx = Math.min(width - 1, Math.max(0, x + dx));
              acc += k[dy + 1] * k[dx + 1] * src[(yy * width + xx) * 4 + ch];
            }
          }
          px[o + ch] = acc / 16;
        }
      }
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}
