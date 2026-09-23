import { throwIfCancelled } from "../cancellation";
import {
  loadAiModel,
  loadedModel,
  type AiModelInfo,
} from "../aiUpscaler";
import {
  RESTORATION_MODELS,
  type RestorationModelId,
} from "./modelRegistry";

export interface ModelHealthReport {
  id: RestorationModelId;
  label: string;
  status: "ok" | "failed";
  heavy: boolean;
  sizeMb: number;
  elapsedMs: number;
  provider: string | null;
  execution: "worker" | "main" | null;
  threads: number | null;
  scale: number | null;
  inputType: "float32" | "float16" | null;
  inputLayout: "NCHW" | "NHWC" | null;
  outputLayout: "NCHW" | "NHWC" | null;
  fixedWidth: number | null;
  fixedHeight: number | null;
  smokeTestMs: number | null;
  stressTestMs: number | null;
  benchmarkTileMs: number | null;
  estimatedTilesPerSecond: number | null;
  fromCache: boolean | null;
  error: string | null;
}

export interface ModelHealthSummary {
  reports: ModelHealthReport[];
  passed: number;
  failed: number;
  elapsedMs: number;
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : "raison inconnue";
}

function successReport(
  id: RestorationModelId,
  info: AiModelInfo,
  elapsedMs: number,
): ModelHealthReport {
  const model = RESTORATION_MODELS[id];
  return {
    id,
    label: model.label,
    status: "ok",
    heavy: model.heavy,
    sizeMb: model.sizeMb,
    elapsedMs,
    provider: info.provider,
    execution: info.execution,
    threads: info.threads,
    scale: info.scale,
    inputType: info.inputType,
    inputLayout: info.inputLayout,
    outputLayout: info.outputLayout,
    fixedWidth: info.fixedWidth,
    fixedHeight: info.fixedHeight,
    smokeTestMs: info.smokeTestMs,
    stressTestMs: info.stressTestMs,
    benchmarkTileMs: info.benchmarkTileMs,
    estimatedTilesPerSecond: info.estimatedTilesPerSecond,
    fromCache: info.fromCache,
    error: null,
  };
}

/**
 * Qualification matérielle réelle des moteurs déclarés dans le registre.
 *
 * Chaque modèle est téléchargé/lu du cache, initialisé sur le meilleur backend
 * disponible puis obligé d'exécuter la mire RGBA de qualification intégrée à
 * loadAiModel(). Un modèle n'est donc jamais marqué "OK" sur un simple build.
 *
 * Attention : le test complet peut télécharger plus de 200 Mo au premier
 * passage. Il est volontairement déclenché par l'utilisateur.
 */
export async function qualifyAllRestorationModels(
  onProgress?: (
    ratio: number,
    label: string,
    partial: readonly ModelHealthReport[],
  ) => void,
): Promise<ModelHealthSummary> {
  const ids = Object.keys(RESTORATION_MODELS) as RestorationModelId[];
  const reports: ModelHealthReport[] = [];
  const globalStart = performance.now();

  for (let index = 0; index < ids.length; index += 1) {
    throwIfCancelled();
    const id = ids[index];
    const model = RESTORATION_MODELS[id];
    const base = index / ids.length;
    const span = 1 / ids.length;
    const started = performance.now();

    try {
      const info = await loadAiModel(
        {
          kind: "url",
          url: model.url,
          label: model.label,
        },
        (ratio, label) =>
          onProgress?.(
            base + ratio * span,
            `Moteur ${index + 1}/${ids.length} · ${label}`,
            reports,
          ),
      );
      const report = successReport(
        id,
        info,
        performance.now() - started,
      );
      reports.push(report);
      onProgress?.(
        (index + 1) / ids.length,
        `✓ ${model.label} · ${info.provider.toUpperCase()} · x${info.scale} · ~${info.estimatedTilesPerSecond.toFixed(1)} tuiles/s`,
        reports,
      );
    } catch (reason) {
      reports.push({
        id,
        label: model.label,
        status: "failed",
        heavy: model.heavy,
        sizeMb: model.sizeMb,
        elapsedMs: performance.now() - started,
        provider: null,
        execution: null,
        threads: null,
        scale: null,
        inputType: null,
        inputLayout: null,
        outputLayout: null,
        fixedWidth: null,
        fixedHeight: null,
        smokeTestMs: null,
        stressTestMs: null,
        benchmarkTileMs: null,
        estimatedTilesPerSecond: null,
        fromCache: null,
        error: errorText(reason),
      });
      onProgress?.(
        (index + 1) / ids.length,
        `✗ ${model.label} · échec de qualification`,
        reports,
      );
    }
  }

  return {
    reports,
    passed: reports.filter((report) => report.status === "ok").length,
    failed: reports.filter((report) => report.status === "failed").length,
    elapsedMs: performance.now() - globalStart,
  };
}

export function activeQualifiedModel(): AiModelInfo | null {
  const current = loadedModel();
  return current?.qualified ? current : null;
}
