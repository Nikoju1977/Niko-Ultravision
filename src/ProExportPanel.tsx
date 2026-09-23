import { useState } from "react";
import { encodeProFormat, PRO_FORMATS, type ProFormat } from "./lib/codecs/proExport";

type ExportState = { state: "idle" | "busy" | "ready" | "failed"; blob?: Blob; detail?: string };

interface Props {
  master: Blob;
  baseName: string;
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} Mo` : `${Math.round(bytes / 1024)} Ko`;
}

function fileName(baseName: string, format: ProFormat, extension: string): string {
  // Le PNG optimisé ne doit pas écraser le master PNG.
  return format === "oxipng" ? `${baseName}-sans-perte.png` : `${baseName}.${extension}`;
}

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/** Exports pro : AVIF, JPEG XL, MozJPEG, PNG optimisé, WebP — encodés localement. */
export default function ProExportPanel({ master, baseName }: Props) {
  const [states, setStates] = useState<Partial<Record<ProFormat, ExportState>>>({});

  async function run(format: ProFormat) {
    const info = PRO_FORMATS.find((entry) => entry.id === format)!;
    const current = states[format];
    if (current?.state === "ready" && current.blob) {
      save(current.blob, fileName(baseName, format, info.extension));
      return;
    }
    if (current?.state === "busy") return;
    setStates((previous) => ({ ...previous, [format]: { state: "busy", detail: "Encodage…" } }));
    try {
      const { blob, elapsedMs } = await encodeProFormat(master, format);
      const ratio = master.size > 0 ? Math.round((1 - blob.size / master.size) * 100) : 0;
      setStates((previous) => ({
        ...previous,
        [format]: {
          state: "ready",
          blob,
          detail: `${formatSize(blob.size)}${ratio > 0 ? ` · −${ratio} %` : ""} · ${(elapsedMs / 1000).toFixed(1)} s`,
        },
      }));
      save(blob, fileName(baseName, format, info.extension));
    } catch (reason) {
      setStates((previous) => ({
        ...previous,
        [format]: { state: "failed", detail: reason instanceof Error ? reason.message : "Encodage impossible" },
      }));
    }
  }

  return (
    <details className="pro-export">
      <summary>
        <span>Exports pro</span>
        <small>AVIF · JPEG XL · MozJPEG · PNG optimisé · WebP — encodés sur l'appareil</small>
      </summary>
      <div className="pro-export-list">
        {PRO_FORMATS.map((info) => {
          const state = states[info.id];
          return (
            <div className="pro-export-row" key={info.id}>
              <div>
                <strong>{info.label}</strong>
                <small>{state?.detail ?? info.hint}</small>
              </div>
              <button
                type="button"
                className="secondary-button"
                onClick={() => void run(info.id)}
                disabled={state?.state === "busy"}
              >
                {state?.state === "busy" ? "…" : state?.state === "ready" ? "Télécharger" : state?.state === "failed" ? "Réessayer" : "Exporter"}
              </button>
            </div>
          );
        })}
      </div>
    </details>
  );
}
