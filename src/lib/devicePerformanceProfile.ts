export interface PersistedModelPerformance {
  label: string;
  successCount: number;
  failureCount: number;
  lastProvider: "webgpu" | "wasm" | null;
  lastExecution: "worker" | "main" | null;
  lastScale: number | null;
  benchmarkTileMs: number | null;
  estimatedTilesPerSecond: number | null;
  lastError: string | null;
  updatedAt: number;
}

export interface DevicePerformanceProfile {
  version: 1;
  signature: string;
  updatedAt: number;
  models: Record<string, PersistedModelPerformance>;
}

const STORAGE_KEY = "ultravision.device-performance.v1";

function deviceSignature(): string {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    ? "mobile"
    : "desktop";
  const memory =
    typeof nav.deviceMemory === "number"
      ? String(nav.deviceMemory)
      : "unknown";
  const cores = String(navigator.hardwareConcurrency || 1);
  const gpu = "gpu" in navigator ? "webgpu-capable" : "no-webgpu";
  return [mobile, memory, cores, gpu].join(":");
}

function emptyProfile(): DevicePerformanceProfile {
  return {
    version: 1,
    signature: deviceSignature(),
    updatedAt: Date.now(),
    models: {},
  };
}

export function readDevicePerformanceProfile(): DevicePerformanceProfile {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyProfile();
    const parsed = JSON.parse(raw) as DevicePerformanceProfile;
    if (
      parsed?.version !== 1 ||
      parsed.signature !== deviceSignature() ||
      !parsed.models
    ) {
      return emptyProfile();
    }
    return parsed;
  } catch {
    return emptyProfile();
  }
}

function writeProfile(profile: DevicePerformanceProfile): void {
  try {
    profile.updatedAt = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // Le profil est une optimisation. L'application reste fonctionnelle
    // si le navigateur refuse le stockage local.
  }
}

export function recordModelPerformanceSuccess(
  label: string,
  details: {
    provider: "webgpu" | "wasm";
    execution: "worker" | "main";
    scale: number;
    benchmarkTileMs: number;
    estimatedTilesPerSecond: number;
  },
): void {
  const profile = readDevicePerformanceProfile();
  const previous = profile.models[label];
  const successCount = (previous?.successCount ?? 0) + 1;

  const blend = (
    previousValue: number | null | undefined,
    next: number,
  ) =>
    previousValue == null
      ? next
      : previousValue * 0.65 + next * 0.35;

  profile.models[label] = {
    label,
    successCount,
    failureCount: previous?.failureCount ?? 0,
    lastProvider: details.provider,
    lastExecution: details.execution,
    lastScale: details.scale,
    benchmarkTileMs: blend(
      previous?.benchmarkTileMs,
      details.benchmarkTileMs,
    ),
    estimatedTilesPerSecond: blend(
      previous?.estimatedTilesPerSecond,
      details.estimatedTilesPerSecond,
    ),
    lastError: null,
    updatedAt: Date.now(),
  };
  writeProfile(profile);
}

export function recordModelPerformanceFailure(
  label: string,
  error: string,
): void {
  const profile = readDevicePerformanceProfile();
  const previous = profile.models[label];
  profile.models[label] = {
    label,
    successCount: previous?.successCount ?? 0,
    failureCount: (previous?.failureCount ?? 0) + 1,
    lastProvider: previous?.lastProvider ?? null,
    lastExecution: previous?.lastExecution ?? null,
    lastScale: previous?.lastScale ?? null,
    benchmarkTileMs: previous?.benchmarkTileMs ?? null,
    estimatedTilesPerSecond:
      previous?.estimatedTilesPerSecond ?? null,
    lastError: error.slice(0, 280),
    updatedAt: Date.now(),
  };
  writeProfile(profile);
}

export function modelPerformanceScore(label: string): number {
  const entry = readDevicePerformanceProfile().models[label];
  if (!entry) return 0;

  const reliability =
    entry.successCount /
    Math.max(1, entry.successCount + entry.failureCount);
  const throughput = Math.min(
    1,
    (entry.estimatedTilesPerSecond ?? 0) / 24,
  );
  const recentFailurePenalty = entry.lastError ? 0.35 : 0;

  return (
    reliability * 60 +
    throughput * 40 -
    recentFailurePenalty * 100
  );
}

export function knownStableModel(label: string): boolean {
  const entry = readDevicePerformanceProfile().models[label];
  if (!entry) return false;
  return (
    entry.successCount >= 1 &&
    entry.successCount >= entry.failureCount &&
    entry.lastError === null
  );
}

export function sortLabelsByDeviceEvidence(
  labels: string[],
): string[] {
  return [...labels].sort(
    (a, b) => modelPerformanceScore(b) - modelPerformanceScore(a),
  );
}

export function devicePerformanceSummary(): string {
  const profile = readDevicePerformanceProfile();
  const entries = Object.values(profile.models);
  const stable = entries.filter(
    (entry) =>
      entry.successCount >= 1 &&
      entry.successCount >= entry.failureCount &&
      !entry.lastError,
  );
  return stable.length
    ? `${stable.length} moteur(s) déjà qualifié(s) sur cet appareil`
    : "aucun historique moteur qualifié sur cet appareil";
}
