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

export async function decodeImageFile(file: Blob): Promise<DecodedImage> {
  const directBitmap = await decodeBitmap(file);
  if (directBitmap) return directBitmap;

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
