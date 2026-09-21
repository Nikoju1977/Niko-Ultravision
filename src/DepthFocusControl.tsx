import { useEffect, useState } from "react";
import { decodeImageFile } from "./lib/imageDecode";
import { buildDepthConfidenceMap } from "./lib/depth/depthConfidence";
import { estimateRelativeDepth } from "./lib/depth/depthEstimator";
import {
  DEFAULT_DEPTH_FOCUS,
  MAX_DEPTH_PLANES,
  MIN_DEPTH_PLANES,
  type DepthFocusSettings,
} from "./lib/depth/depthTypes";
import {
  createConfidencePreview,
  createDepthPreview,
} from "./lib/depth/depthPreview";

export type { DepthFocusSettings } from "./lib/depth/depthTypes";

interface Props {
  file: File | null;
  disabled?: boolean;
  value: DepthFocusSettings;
  onChange: (next: DepthFocusSettings) => void;
}

function pct(value: number): number {
  return Math.round(value * 100);
}

export default function DepthFocusControl({
  file,
  disabled = false,
  value,
  onChange,
}: Props) {
  const [depthPreview, setDepthPreview] = useState<string | null>(null);
  const [confidencePreview, setConfidencePreview] = useState<string | null>(null);
  const [status, setStatus] = useState("Importe une image pour analyser les plans Z.");

  useEffect(() => {
    let alive = true;

    if (!file || !value.enabled) {
      setDepthPreview(null);
      setConfidencePreview(null);
      setStatus(value.enabled ? "Importe une image pour analyser les plans Z." : "Depth Focus Precision désactivé.");
      return () => {
        alive = false;
      };
    }

    void (async () => {
      let decoded: Awaited<ReturnType<typeof decodeImageFile>> | null = null;
      try {
        setStatus("Estimation relative de profondeur…");
        decoded = await decodeImageFile(file);

        const maxSide = 520;
        const scale = Math.min(1, maxSide / Math.max(decoded.width, decoded.height));
        const width = Math.max(32, Math.round(decoded.width * scale));
        const height = Math.max(32, Math.round(decoded.height * scale));

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas 2D indisponible.");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(decoded.source, 0, 0, width, height);

        const estimate = await estimateRelativeDepth(canvas, value.centerBias, maxSide);
        const confidence = buildDepthConfidenceMap(estimate.depth, estimate.structure);
        if (!alive) return;

        setDepthPreview(createDepthPreview(estimate.depth).toDataURL("image/png"));
        setConfidencePreview(createConfidencePreview(confidence).toDataURL("image/png"));

        let total = 0;
        for (const c of confidence.values) total += c;
        const mean = confidence.values.length ? total / confidence.values.length : 0;
        setStatus(value.planes + " plans Z · confiance moyenne " + Math.round(mean * 100) + " %");
      } catch (reason) {
        if (alive) {
          setDepthPreview(null);
          setConfidencePreview(null);
          setStatus(reason instanceof Error ? reason.message : "Analyse de profondeur indisponible.");
        }
      } finally {
        decoded?.close();
      }
    })();

    return () => {
      alive = false;
    };
  }, [file, value.enabled, value.centerBias, value.planes]);

  const safe = {
    ...DEFAULT_DEPTH_FOCUS,
    ...value,
    planes: Math.max(MIN_DEPTH_PLANES, Math.min(MAX_DEPTH_PLANES, Math.round(value.planes))),
  };

  return (
    <div className="depth-focus-precision-box">
      <div className="deep-focus-head">
        <div>
          <strong>UltraVision Depth Focus Precision</strong>
          <span>10–16 plans Z · confiance · fusion douce · restauration adaptative</span>
        </div>
        <label className="switch-row">
          <input
            type="checkbox"
            checked={safe.enabled}
            disabled={disabled}
            onChange={(event) => onChange({ ...safe, enabled: event.target.checked })}
          />
          <span>{safe.enabled ? "ACTIF" : "OFF"}</span>
        </label>
      </div>

      <p className="model-note">
        La carte Z est une estimation de profondeur relative calculée localement à partir des structures de l’image.
        Ce n’est pas une distance physique ni une reconstruction 3D. Chaque plan reçoit une restauration différente,
        avec seuil de confiance et garde-fous anti-bruit.
      </p>

      <div className="depth-focus-controls">
        <label>
          <span>Plans Z</span>
          <strong>{safe.planes}</strong>
          <input
            type="range"
            min={MIN_DEPTH_PLANES}
            max={MAX_DEPTH_PLANES}
            step={1}
            value={safe.planes}
            disabled={disabled || !safe.enabled}
            onChange={(event) => onChange({ ...safe, planes: Number(event.target.value) })}
          />
        </label>

        <label>
          <span>Force globale</span>
          <strong>{pct(safe.globalStrength)} %</strong>
          <input
            type="range"
            min={15}
            max={85}
            step={1}
            value={pct(safe.globalStrength)}
            disabled={disabled || !safe.enabled}
            onChange={(event) => onChange({ ...safe, globalStrength: Number(event.target.value) / 100 })}
          />
        </label>

        <label>
          <span>Seuil de confiance</span>
          <strong>{pct(safe.confidenceGate)} %</strong>
          <input
            type="range"
            min={10}
            max={80}
            step={1}
            value={pct(safe.confidenceGate)}
            disabled={disabled || !safe.enabled}
            onChange={(event) => onChange({ ...safe, confidenceGate: Number(event.target.value) / 100 })}
          />
        </label>

        <label>
          <span>Fusion inter-plans</span>
          <strong>{pct(safe.fusionFeather)} %</strong>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={pct(safe.fusionFeather)}
            disabled={disabled || !safe.enabled}
            onChange={(event) => onChange({ ...safe, fusionFeather: Number(event.target.value) / 100 })}
          />
        </label>

        <label>
          <span>Priorité centre</span>
          <strong>{pct(safe.centerBias)} %</strong>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={pct(safe.centerBias)}
            disabled={disabled || !safe.enabled}
            onChange={(event) => onChange({ ...safe, centerBias: Number(event.target.value) / 100 })}
          />
        </label>
      </div>

      <div className="depth-preview-grid">
        <div>
          <strong>Profondeur relative</strong>
          {depthPreview ? <img src={depthPreview} alt="Carte de profondeur relative" /> : <div className="depth-preview-empty" />}
          <span>Chaud = relativement proche · bleu = relativement lointain.</span>
        </div>
        <div>
          <strong>Confiance</strong>
          {confidencePreview ? <img src={confidencePreview} alt="Carte de confiance de profondeur" /> : <div className="depth-preview-empty" />}
          <span>Plus la zone est lumineuse, plus le traitement peut être ciblé.</span>
        </div>
      </div>

      <div className="depth-status">{status}</div>
    </div>
  );
}
