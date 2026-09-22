/// <reference lib="webworker" />
/**
 * Worker d'inférence : la session ONNX et toute la conversion tenseur ↔ pixels
 * tournent ici, hors du thread de l'interface.
 */
import {
  activeThreads,
  createSession,
  errorText,
  getOrt,
  isIsolated,
  probeModel,
  releaseSession,
  runTile,
  type KeepRect,
  type ModelMeta,
  type OrtSession,
} from "./aiEngineCore";

export type WorkerRequest =
  | { id: number; type: "load"; weights: ArrayBuffer; threads: number; tileSide: number; preferGpu: boolean }
  | { id: number; type: "tile"; rgba: ArrayBuffer; width: number; height: number; keep: KeepRect }
  | { id: number; type: "release" };

export type WorkerResponse =
  | { id: number; ok: true; type: "load"; meta: ModelMeta; threads: number; isolated: boolean }
  | { id: number; ok: true; type: "tile"; data: ArrayBuffer; width: number; height: number }
  | { id: number; ok: true; type: "release" }
  | { id: number; ok: false; error: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

let session: OrtSession | null = null;
let meta: ModelMeta | null = null;
// Les octets du modèle doivent vivre aussi longtemps que la session
// (ORT les utilise directement, sans copie).
let weightsRef: Uint8Array | null = null;

scope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === "load") {
      const ort = await getOrt(request.threads);
      await releaseSession(session);
      session = null;
      meta = null;
      weightsRef = new Uint8Array(request.weights);
      const created = await createSession(ort, weightsRef, request.preferGpu);
      try {
        meta = await probeModel(ort, created.session, created.provider, request.tileSide);
      } catch (reason) {
        await releaseSession(created.session);
        throw reason;
      }
      session = created.session;
      const reply: WorkerResponse = {
        id: request.id,
        ok: true,
        type: "load",
        meta,
        threads: activeThreads(),
        isolated: isIsolated(),
      };
      scope.postMessage(reply);
      return;
    }

    if (request.type === "tile") {
      if (!session || !meta) throw new Error("Aucun modèle chargé dans le worker.");
      const ort = await getOrt(1);
      const result = await runTile(
        ort,
        session,
        meta,
        new Uint8ClampedArray(request.rgba),
        request.width,
        request.height,
        request.keep,
      );
      const buffer = result.data.buffer as ArrayBuffer;
      const reply: WorkerResponse = {
        id: request.id,
        ok: true,
        type: "tile",
        data: buffer,
        width: result.width,
        height: result.height,
      };
      scope.postMessage(reply, [buffer]);
      return;
    }

    await releaseSession(session);
    session = null;
    meta = null;
    weightsRef = null;
    scope.postMessage({ id: request.id, ok: true, type: "release" } satisfies WorkerResponse);
  } catch (reason) {
    scope.postMessage({ id: request.id, ok: false, error: errorText(reason) } satisfies WorkerResponse);
  }
};
