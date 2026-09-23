/**
 * Exports pro : ré-encode le master avec les meilleurs codecs photo gratuits.
 */
import { decodeImageFile } from "../imageDecode";
import type { CodecRequest, CodecResponse, ProFormat } from "./codecWorker";

export type { ProFormat };

export interface ProFormatInfo {
  id: ProFormat;
  label: string;
  extension: string;
  mime: string;
  hint: string;
}

export const PRO_FORMATS: ProFormatInfo[] = [
  { id: "avif", label: "AVIF", extension: "avif", mime: "image/avif", hint: "Le plus léger à qualité égale · lisible partout" },
  { id: "jxl", label: "JPEG XL", extension: "jxl", mime: "image/jxl", hint: "Format le plus avancé · archivage et logiciels pro" },
  { id: "mozjpeg", label: "JPEG MozJPEG", extension: "jpg", mime: "image/jpeg", hint: "Compatible partout · plus léger que le JPEG standard" },
  { id: "oxipng", label: "PNG optimisé", extension: "png", mime: "image/png", hint: "Sans aucune perte · taille réduite" },
  { id: "webp", label: "WebP", extension: "webp", mime: "image/webp", hint: "Web et réseaux sociaux" },
];

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (bytes: ArrayBuffer) => void; reject: (error: Error) => void }>();

function codecWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./codecWorker.ts", import.meta.url), { type: "module", name: "ultravision-codecs" });
  worker.onmessage = (event: MessageEvent<CodecResponse>) => {
    const entry = pending.get(event.data.id);
    if (!entry) return;
    pending.delete(event.data.id);
    if (event.data.ok) entry.resolve(event.data.bytes);
    else entry.reject(new Error(event.data.error));
  };
  worker.onerror = (event) => {
    event.preventDefault();
    const error = new Error("Encodeur arrêté : " + (event.message || "module indisponible"));
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

export async function encodeProFormat(master: Blob, format: ProFormat): Promise<{ blob: Blob; elapsedMs: number }> {
  const info = PRO_FORMATS.find((entry) => entry.id === format)!;
  const started = performance.now();
  const decoded = await decodeImageFile(master);
  let data: ArrayBuffer;
  const { width, height } = decoded;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Canvas 2D indisponible.");
    ctx.drawImage(decoded.source, 0, 0);
    data = ctx.getImageData(0, 0, width, height).data.buffer as ArrayBuffer;
    canvas.width = 1;
    canvas.height = 1;
  } finally {
    decoded.close();
  }
  const request: CodecRequest = {
    id: nextId++,
    format,
    data,
    width,
    height,
    mobile: /Android|iPhone|iPad/i.test(navigator.userAgent),
  };
  const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
    pending.set(request.id, { resolve, reject });
    codecWorker().postMessage(request, [data]);
  });
  return { blob: new Blob([bytes], { type: info.mime }), elapsedMs: performance.now() - started };
}
