/**
 * Finition « mélange adaptatif » IA / original.
 *
 * Une super-résolution IA durcit tout : elle rend le texte et les objets plus
 * nets, mais lisse la peau (effet cire) et transforme les bords flous en
 * escaliers. Ce module combine, pixel par pixel :
 *   - l'IA à pleine force là où l'original contient une vraie structure
 *     (texte, objets, reflets : fort gradient local) ;
 *   - l'original fidèlement agrandi sur la peau et les aplats, où il garde
 *     son grain naturel ;
 *   - un léger lissage des contours durs créés par l'IA (anti-escalier).
 *
 * Fonction pure sur tableaux RGBA : aucun canvas, testable hors navigateur.
 */

export interface BlendOptions {
  /** Poids IA minimal (peau, aplats). */
  floor?: number;
  /** Gradient (0–255/8) à partir duquel la structure commence à compter. */
  detailStart?: number;
  /** Étendue du passage aplat → structure. */
  detailRange?: number;
  /** Force de l'anti-escalier sur les contours durs de l'IA. */
  antiStair?: number;
}

function luma(data: Uint8ClampedArray, n: number): Float32Array {
  const out = new Float32Array(n);
  for (let p = 0, i = 0; p < n; p += 1, i += 4) {
    out[p] = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  }
  return out;
}

/** Module du gradient de Sobel, divisé par 8 (unités 0–255). */
function sobel(y: Float32Array, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let r = 0; r < height; r += 1) {
    const r0 = Math.max(0, r - 1) * width;
    const r1 = r * width;
    const r2 = Math.min(height - 1, r + 1) * width;
    for (let c = 0; c < width; c += 1) {
      const c0 = Math.max(0, c - 1);
      const c2 = Math.min(width - 1, c + 1);
      const gx =
        y[r0 + c2] + 2 * y[r1 + c2] + y[r2 + c2] -
        y[r0 + c0] - 2 * y[r1 + c0] - y[r2 + c0];
      const gy =
        y[r2 + c0] + 2 * y[r2 + c] + y[r2 + c2] -
        y[r0 + c0] - 2 * y[r0 + c] - y[r0 + c2];
      out[r1 + c] = Math.sqrt(gx * gx + gy * gy) / 8;
    }
  }
  return out;
}

/** Flou de boîte séparable, en place (3 passes ≈ gaussien). */
function boxBlur(data: Float32Array, width: number, height: number, radius: number): void {
  const tmp = new Float32Array(Math.max(width, height));
  const size = 2 * radius + 1;
  for (let r = 0; r < height; r += 1) {
    const row = r * width;
    let acc = 0;
    for (let k = -radius; k <= radius; k += 1) acc += data[row + Math.min(width - 1, Math.max(0, k))];
    for (let c = 0; c < width; c += 1) {
      tmp[c] = acc / size;
      acc += data[row + Math.min(width - 1, c + radius + 1)] - data[row + Math.max(0, c - radius)];
    }
    data.set(tmp.subarray(0, width), row);
  }
  for (let c = 0; c < width; c += 1) {
    let acc = 0;
    for (let k = -radius; k <= radius; k += 1) acc += data[Math.min(height - 1, Math.max(0, k)) * width + c];
    for (let r = 0; r < height; r += 1) {
      tmp[r] = acc / size;
      acc +=
        data[Math.min(height - 1, r + radius + 1) * width + c] -
        data[Math.max(0, r - radius) * width + c];
    }
    for (let r = 0; r < height; r += 1) data[r * width + c] = tmp[r];
  }
}

/**
 * @param ai       master IA, RGBA
 * @param faithful original agrandi à la même taille (rééchantillonnage HQ), RGBA
 * @returns        nouveau tableau RGBA mélangé
 */
export function adaptiveBlend(
  ai: Uint8ClampedArray,
  faithful: Uint8ClampedArray,
  width: number,
  height: number,
  options: BlendOptions = {},
): { data: Uint8ClampedArray; meanAiWeight: number } {
  const floor = options.floor ?? 0.3;
  const start = options.detailStart ?? 1.2;
  const range = options.detailRange ?? 4;
  const antiStair = options.antiStair ?? 0.45;
  const n = width * height;

  // Carte de structure de l'original (lissée ≈ σ 3 px).
  const structure = sobel(luma(faithful, n), width, height);
  for (let pass = 0; pass < 3; pass += 1) boxBlur(structure, width, height, 2);

  // Contours durs de l'IA (pour l'anti-escalier).
  const aiEdges = sobel(luma(ai, n), width, height);

  const out = new Uint8ClampedArray(ai.length);
  let weightSum = 0;
  for (let r = 0; r < height; r += 1) {
    const r0 = Math.max(0, r - 1) * width;
    const r1 = r * width;
    const r2 = Math.min(height - 1, r + 1) * width;
    for (let c = 0; c < width; c += 1) {
      const p = r1 + c;
      const m = Math.min(1, Math.max(0, (structure[p] - start) / range));
      const w = floor + (1 - floor) * m;
      weightSum += w;
      const e = antiStair * Math.min(1, Math.max(0, (aiEdges[p] - 6) / 14));
      const c0 = Math.max(0, c - 1);
      const c2 = Math.min(width - 1, c + 1);
      const i = p * 4;
      for (let ch = 0; ch < 3; ch += 1) {
        let local = ai[i + ch];
        if (e > 0) {
          const box =
            (ai[(r0 + c0) * 4 + ch] + ai[(r0 + c) * 4 + ch] + ai[(r0 + c2) * 4 + ch] +
              ai[(r1 + c0) * 4 + ch] + ai[i + ch] + ai[(r1 + c2) * 4 + ch] +
              ai[(r2 + c0) * 4 + ch] + ai[(r2 + c) * 4 + ch] + ai[(r2 + c2) * 4 + ch]) / 9;
          local = local * (1 - e) + box * e;
        }
        out[i + ch] = w * local + (1 - w) * faithful[i + ch];
      }
      out[i + 3] = 255;
    }
  }
  return { data: out, meanAiWeight: weightSum / n };
}
