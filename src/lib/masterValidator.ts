import { decodeImageFile } from "./imageDecode";
import type { Size } from "./geometry";

export interface MasterValidationReport {
  valid: boolean;
  width: number;
  height: number;
  bytes: number;
  mimeType: string;
  dimensionMatch: boolean;
  nonEmpty: boolean;
  message: string;
}

export async function validateImageMaster(
  blob: Blob,
  expected: Size,
): Promise<MasterValidationReport> {
  if (!blob || blob.size <= 128) {
    return {
      valid: false,
      width: 0,
      height: 0,
      bytes: blob?.size ?? 0,
      mimeType: blob?.type ?? "",
      dimensionMatch: false,
      nonEmpty: false,
      message: "Master vide ou anormalement petit.",
    };
  }

  let decoded: Awaited<ReturnType<typeof decodeImageFile>> | null = null;
  try {
    decoded = await decodeImageFile(blob);
    const dimensionMatch =
      decoded.width === expected.width &&
      decoded.height === expected.height;

    const probe = document.createElement("canvas");
    const probeWidth = Math.max(
      8,
      Math.min(64, decoded.width),
    );
    const probeHeight = Math.max(
      8,
      Math.min(64, decoded.height),
    );
    probe.width = probeWidth;
    probe.height = probeHeight;
    const ctx = probe.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      throw new Error("Canvas de validation finale indisponible.");
    }
    ctx.drawImage(decoded.source, 0, 0, probeWidth, probeHeight);
    const pixels = ctx.getImageData(
      0,
      0,
      probeWidth,
      probeHeight,
    ).data;

    let finitePixels = 0;
    let visiblePixels = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (
        Number.isFinite(pixels[i]) &&
        Number.isFinite(pixels[i + 1]) &&
        Number.isFinite(pixels[i + 2])
      ) {
        finitePixels += 1;
      }
      if (pixels[i + 3] > 0) visiblePixels += 1;
    }

    const sampleCount = Math.max(1, pixels.length / 4);
    const nonEmpty =
      finitePixels === sampleCount &&
      visiblePixels > sampleCount * 0.02;
    const valid = dimensionMatch && nonEmpty;

    return {
      valid,
      width: decoded.width,
      height: decoded.height,
      bytes: blob.size,
      mimeType: blob.type,
      dimensionMatch,
      nonEmpty,
      message: valid
        ? "Master décodable, dimensions conformes et pixels valides."
        : [
            dimensionMatch
              ? null
              : `dimensions ${decoded.width}×${decoded.height} au lieu de ${expected.width}×${expected.height}`,
            nonEmpty ? null : "pixels de sortie invalides ou transparents",
          ]
            .filter(Boolean)
            .join(" · "),
    };
  } catch (reason) {
    return {
      valid: false,
      width: 0,
      height: 0,
      bytes: blob.size,
      mimeType: blob.type,
      dimensionMatch: false,
      nonEmpty: false,
      message:
        "Master non décodable : " +
        (reason instanceof Error ? reason.message : "raison inconnue"),
    };
  } finally {
    decoded?.close();
  }
}
