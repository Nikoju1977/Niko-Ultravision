export interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
}

function sniffImageMime(bytes: Uint8Array, fallback: string): string {
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) return "image/png";
  if (bytes.length >= 6) {
    const signature = String.fromCharCode(...bytes.slice(0, 6));
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  }
  if (bytes.length >= 12) {
    const riff = String.fromCharCode(...bytes.slice(0, 4));
    const webp = String.fromCharCode(...bytes.slice(8, 12));
    if (riff === "RIFF" && webp === "WEBP") return "image/webp";

    const ftyp = String.fromCharCode(...bytes.slice(4, 8));
    const brand = String.fromCharCode(...bytes.slice(8, 12)).toLowerCase();
    if (ftyp === "ftyp") {
      if (brand === "avif" || brand === "avis") return "image/avif";
      if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)) return "image/heic";
    }
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  return fallback || "application/octet-stream";
}

async function decodeBitmap(blob: Blob): Promise<DecodedImage | null> {
  if (!("createImageBitmap" in window)) return null;
  try {
    const bitmap = await createImageBitmap(blob);
    if (bitmap.width > 0 && bitmap.height > 0) {
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      };
    }
    bitmap.close();
  } catch {
    // Continue vers les décodeurs de secours.
  }
  return null;
}

async function decodeHtmlImage(blob: Blob): Promise<DecodedImage> {
  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.decoding = "async";

  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Décodage HTML impossible."));
      image.src = url;
    });

    if (!image.naturalWidth || !image.naturalHeight) {
      throw new Error("Dimensions de l'image introuvables.");
    }

    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close: () => URL.revokeObjectURL(url),
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/**
 * Sur certains Android, createImageBitmap produit des pixels corrompus pour
 * des JPEG valides (bandes, couleurs inversées). Une fois par fichier, on
 * compare une vignette décodée par les deux voies ; en cas d'écart, la voie
 * <img> du navigateur (la plus éprouvée) est utilisée pour ce fichier.
 */
const bitmapTrust = new WeakMap<Blob, boolean>();

function thumbnail(source: CanvasImageSource, width: number, height: number): Uint8ClampedArray | null {
  const canvas = document.createElement("canvas");
  canvas.width = 48;
  canvas.height = Math.max(1, Math.round((48 * height) / width));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
}

async function bitmapIsTrustworthy(file: Blob, bitmap: DecodedImage): Promise<boolean> {
  if (!/android/i.test(navigator.userAgent)) return true;
  const known = bitmapTrust.get(file);
  if (known !== undefined) return known;
  let trusted = true;
  try {
    const html = await decodeHtmlImage(file);
    try {
      const a = thumbnail(bitmap.source, bitmap.width, bitmap.height);
      const b = thumbnail(html.source, html.width, html.height);
      if (a && b && a.length === b.length && html.width === bitmap.width && html.height === bitmap.height) {
        let diff = 0;
        for (let i = 0; i < a.length; i += 4) {
          diff += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
        }
        trusted = diff / ((a.length / 4) * 3) < 6;
      }
    } finally {
      html.close();
    }
  } catch {
    trusted = true;
  }
  bitmapTrust.set(file, trusted);
  return trusted;
}

export async function decodeImageFile(file: Blob): Promise<DecodedImage> {
  // Android : décodage logiciel standard du navigateur en priorité
  // (createImageBitmap peut rester sur le GPU et se relire corrompu).
  if (/android/i.test(navigator.userAgent)) {
    try {
      return await decodeHtmlImage(file);
    } catch {
      // Continue avec les autres stratégies.
    }
  }
  const directBitmap = await decodeBitmap(file);
  if (directBitmap) {
    if (await bitmapIsTrustworthy(file, directBitmap)) return directBitmap;
    directBitmap.close();
    return decodeHtmlImage(file);
  }

  try {
    return await decodeHtmlImage(file);
  } catch {
    // Sur certains sélecteurs Android/Samsung, le File fourni par le picker
    // peut être décodable une première fois puis échouer via son object URL.
    // On matérialise alors réellement ses octets dans un nouveau Blob local.
  }

  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
    throw new Error("Impossible de lire les octets de cette image sur cet appareil.");
  }

  if (buffer.byteLength === 0) throw new Error("Le fichier image est vide.");

  const head = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 32));
  const mime = sniffImageMime(head, file.type);
  const stableBlob = new Blob([buffer], { type: mime });

  const copiedBitmap = await decodeBitmap(stableBlob);
  if (copiedBitmap) return copiedBitmap;

  try {
    return await decodeHtmlImage(stableBlob);
  } catch {
    if (mime === "image/heic") {
      throw new Error(
        "Cette image HEIC/HEIF n'est pas décodable de façon fiable par ce navigateur Android. Désactive HEIF dans l'appareil photo ou convertis cette photo en JPG/PNG.",
      );
    }
    throw new Error(
      `Image illisible par ce navigateur (type détecté : ${mime || "inconnu"}). Essaie un JPG, PNG, WebP ou AVIF standard.`,
    );
  }
}
