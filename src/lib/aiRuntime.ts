export type AiBackend = "webgpu" | "wasm" | "none";

export interface AiRuntimeReport {
  available: boolean;
  backend: AiBackend;
  webgpu: boolean;
  wasm: boolean;
  deviceMemoryGb: number | null;
  hardwareConcurrency: number;
  recommendedTile: number;
  reason: string;
}

function deviceMemoryGb(): number | null {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return typeof nav.deviceMemory === "number" ? nav.deviceMemory : null;
}

async function webGpuProbe(): Promise<boolean> {
  const nav = navigator as Navigator & {
    gpu?: { requestAdapter: () => Promise<unknown | null> };
  };
  if (!nav.gpu) return false;
  try {
    return Boolean(await nav.gpu.requestAdapter());
  } catch {
    return false;
  }
}

function wasmProbe(): boolean {
  try {
    if (typeof WebAssembly === "undefined") return false;
    const module = new WebAssembly.Module(
      new Uint8Array([0,97,115,109,1,0,0,0]),
    );
    return module instanceof WebAssembly.Module;
  } catch {
    return false;
  }
}

export async function inspectAiRuntime(): Promise<AiRuntimeReport> {
  const [webgpu, wasm] = await Promise.all([webGpuProbe(), Promise.resolve(wasmProbe())]);
  const memory = deviceMemoryGb();
  const cores = navigator.hardwareConcurrency || 1;
  const android = /Android/i.test(navigator.userAgent);
  const recommendedTile = android || (memory !== null && memory <= 4) ? 128 : 192;

  if (webgpu) {
    return {
      available: true,
      backend: "webgpu",
      webgpu,
      wasm,
      deviceMemoryGb: memory,
      hardwareConcurrency: cores,
      recommendedTile,
      reason: "WebGPU réellement initialisable.",
    };
  }

  if (wasm) {
    return {
      available: true,
      backend: "wasm",
      webgpu,
      wasm,
      deviceMemoryGb: memory,
      hardwareConcurrency: cores,
      recommendedTile,
      reason: "WebGPU indisponible, repli WASM disponible.",
    };
  }

  return {
    available: false,
    backend: "none",
    webgpu,
    wasm,
    deviceMemoryGb: memory,
    hardwareConcurrency: cores,
    recommendedTile,
    reason: "Ni WebGPU ni WebAssembly ne sont utilisables dans ce navigateur.",
  };
}
