/// <reference lib="webworker" />
/**
 * Encodeurs photo de référence (WebAssembly, jSquash / Squoosh, Apache-2.0),
 * exécutés hors du thread de l'interface. Chaque codec n'est chargé qu'au
 * premier usage.
 */
export type ProFormat = "avif" | "jxl" | "mozjpeg" | "webp" | "oxipng";

export interface CodecRequest {
  id: number;
  format: ProFormat;
  data: ArrayBuffer;
  width: number;
  height: number;
  mobile: boolean;
}

export type CodecResponse =
  | { id: number; ok: true; bytes: ArrayBuffer }
  | { id: number; ok: false; error: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

async function encode(request: CodecRequest): Promise<ArrayBuffer> {
  const image = new ImageData(new Uint8ClampedArray(request.data), request.width, request.height);
  switch (request.format) {
    case "avif": {
      const { default: avif } = await import("@jsquash/avif/encode");
      // Qualité visuellement transparente, chroma 4:4:4, réglage SSIM.
      return avif(image, {
        quality: 82,
        speed: request.mobile ? 8 : 6,
        subsample: 3,
        enableSharpYUV: true,
        tune: 2,
      });
    }
    case "jxl": {
      const { default: jxl } = await import("@jsquash/jxl/encode");
      return jxl(image, { quality: 92, effort: request.mobile ? 5 : 7, progressive: true });
    }
    case "mozjpeg": {
      const { default: mozjpeg } = await import("@jsquash/jpeg/encode");
      return mozjpeg(image, { quality: 92, progressive: true, optimize_coding: true });
    }
    case "webp": {
      const { default: webp } = await import("@jsquash/webp/encode");
      return webp(image, { quality: 92, method: request.mobile ? 4 : 6 });
    }
    case "oxipng": {
      const { default: optimise } = await import("@jsquash/oxipng/optimise");
      return optimise(image, { level: request.mobile ? 1 : 2, interlace: false });
    }
  }
}

scope.onmessage = async (event: MessageEvent<CodecRequest>) => {
  const request = event.data;
  try {
    const bytes = await encode(request);
    const reply: CodecResponse = { id: request.id, ok: true, bytes };
    scope.postMessage(reply, [bytes]);
  } catch (reason) {
    const reply: CodecResponse = {
      id: request.id,
      ok: false,
      error: reason instanceof Error ? reason.message : String(reason),
    };
    scope.postMessage(reply);
  }
};
