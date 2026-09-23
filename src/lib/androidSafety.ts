/**
 * Sécurité pixels Android.
 *
 * Sur plusieurs téléphones Android (constaté sur Samsung), relire des pixels
 * depuis un canvas accéléré GPU ou depuis un ImageBitmap GPU renvoie par
 * intermittence des données brouillées : bandes verticales, dominante
 * vert/magenta. Tout le pipeline UltraVision relit des pixels : sur Android,
 * les canvas 2D sont donc forcés en rendu logiciel (willReadFrequently), ce
 * qui garde les pixels en mémoire CPU du début à la fin.
 */
export const IS_ANDROID =
  typeof navigator !== "undefined" && /android/i.test(navigator.userAgent);

let installed = false;

export function installAndroidPixelSafety(): void {
  if (installed || !IS_ANDROID || typeof HTMLCanvasElement === "undefined") return;
  installed = true;
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function patched(
    this: HTMLCanvasElement,
    type: string,
    attributes?: Record<string, unknown>,
  ) {
    if (type === "2d") {
      return original.call(this, type, { ...(attributes ?? {}), willReadFrequently: true });
    }
    return original.call(this, type, attributes);
  } as typeof HTMLCanvasElement.prototype.getContext;
}
