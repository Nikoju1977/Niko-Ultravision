import { useEffect, useRef, useState } from "react";
import { decodeImageFile } from "./lib/imageDecode";
import {
  createFocusMapCanvas,
  MAX_DEEP_FOCUS_LAYERS,
  MIN_DEEP_FOCUS_LAYERS,
  type DeepFocusSettings,
} from "./lib/deepFocus";

export type { DeepFocusSettings } from "./lib/deepFocus";

interface Props {
  file: File | null;
  disabled?: boolean;
  value: DeepFocusSettings;
  onChange: (next: DeepFocusSettings) => void;
}

export default function DeepFocusControl({ file, disabled = false, value, onChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [previewStatus, setPreviewStatus] = useState("Importe une image pour générer la carte.");

  useEffect(() => {
    let cancelled = false;

    if (!file || !value.enabled) {
      setPreviewStatus(value.enabled ? "Importe une image pour générer la carte." : "Deep Focus désactivé.");
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = 1;
        canvas.height = 1;
      }
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      setPreviewStatus("Analyse de la focalisation…");
      let decoded: Awaited<ReturnType<typeof decodeImageFile>> | null = null;

      try {
        decoded = await decodeImageFile(file);
        const maxSide = 520;
        const scale = Math.min(1, maxSide / Math.max(decoded.width, decoded.height));
        const width = Math.max(8, Math.round(decoded.width * scale));
        const height = Math.max(8, Math.round(decoded.height * scale));

        const source = document.createElement("canvas");
        source.width = width;
        source.height = height;
        const sourceCtx = source.getContext("2d");
        if (!sourceCtx) throw new Error("Canvas 2D indisponible.");
        sourceCtx.imageSmoothingEnabled = true;
        sourceCtx.imageSmoothingQuality = "high";
        sourceCtx.drawImage(decoded.source, 0, 0, width, height);

        const map = createFocusMapCanvas(source, value.layers);
        if (cancelled) return;

        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = map.width;
        canvas.height = map.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(map, 0, 0);
        setPreviewStatus(
          `${value.layers} plans calculés · bleu = déjà net · jaune/rouge = restauration plus forte`,
        );
      } catch (reason) {
        if (!cancelled) {
          setPreviewStatus(reason instanceof Error ? reason.message : "Carte de focalisation indisponible.");
        }
      } finally {
        decoded?.close();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [file, value.enabled, value.layers]);

  const layers = Math.max(MIN_DEEP_FOCUS_LAYERS, Math.min(MAX_DEEP_FOCUS_LAYERS, Math.round(value.layers)));
  const strengthPercent = Math.round(value.strength * 100);

  return (
    <div className="deep-focus-box">
      <div className="deep-focus-head">
        <div>
          <strong>UltraVision Deep Focus 10+</strong>
          <span>Restauration multi-plan locale · minimum 10 bandes de focalisation</span>
        </div>
        <label className="switch-row">
          <input
            type="checkbox"
            checked={value.enabled}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, enabled: event.target.checked })}
          />
          <span>{value.enabled ? "ACTIF" : "OFF"}</span>
        </label>
      </div>

      <p className="model-note">
        Deep Focus estime le déficit de netteté local puis adapte la restauration sur plusieurs plans.
        Sur une image unique, il ne s'agit pas d'une profondeur métrique réelle : UltraVision n'invente
        pas une information optique qui n'existe plus.
      </p>

      <div className="deep-focus-controls">
        <label>
          <span>Plans de focalisation</span>
          <strong>{layers}</strong>
          <input
            type="range"
            min={MIN_DEEP_FOCUS_LAYERS}
            max={MAX_DEEP_FOCUS_LAYERS}
            step={1}
            value={layers}
            disabled={disabled || !value.enabled}
            onChange={(event) => onChange({ ...value, layers: Number(event.target.value) })}
          />
        </label>

        <label>
          <span>Force de restauration</span>
          <strong>{strengthPercent} %</strong>
          <input
            type="range"
            min={15}
            max={85}
            step={1}
            value={strengthPercent}
            disabled={disabled || !value.enabled}
            onChange={(event) => onChange({ ...value, strength: Number(event.target.value) / 100 })}
          />
        </label>
      </div>

      <div className="focus-map-wrap" aria-live="polite">
        <canvas ref={canvasRef} className="focus-map" />
        <span>{previewStatus}</span>
      </div>
    </div>
  );
}
