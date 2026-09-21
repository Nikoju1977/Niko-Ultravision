import { SCENE_PRESETS, type SceneModeId, type ScenePresetId } from "./lib/scenePresets";
import type { SceneAnalysis } from "./lib/sceneAnalyzer";

interface Props {
  value: SceneModeId;
  disabled?: boolean;
  analysis: SceneAnalysis | null;
  analyzing?: boolean;
  onChange: (mode: SceneModeId) => void;
}

function pct(value: number): string {
  return `${Math.round(value * 100)} %`;
}

export default function ScenePrecisionControl({
  value,
  disabled = false,
  analysis,
  analyzing = false,
  onChange,
}: Props) {
  const presetIds = Object.keys(SCENE_PRESETS) as ScenePresetId[];

  return (
    <div className="scene-precision-box">
      <div className="deep-focus-head">
        <div>
          <strong>UltraVision Scene Precision</strong>
          <span>AutoPilot local + presets Deep Focus / Precision Restore</span>
        </div>
        <span className={value === "auto" ? "badge ok" : "badge"}>{value === "auto" ? "AUTO" : "MANUEL"}</span>
      </div>

      <p className="model-note">
        Le mode Auto analyse localement les structures de l'image. Il ne reconnaît pas sémantiquement les objets :
        il mesure texte probable, contours, aplats et concentration de détails vers le centre.
      </p>

      <button
        type="button"
        className={value === "auto" ? "scene-preset scene-auto active" : "scene-preset scene-auto"}
        disabled={disabled}
        onClick={() => onChange("auto")}
      >
        <strong>Auto</strong>
        <span>
          {analyzing
            ? "Analyse de scène…"
            : analysis
              ? `Recommandation : ${SCENE_PRESETS[analysis.recommendedPreset].label} · confiance ${pct(analysis.confidence)}`
              : "Analyse automatique dès qu'une image est importée."}
        </span>
      </button>

      {analysis && (
        <div className="scene-analysis">
          <strong>{analysis.explanation}</strong>
          <div>
            <span>Texte probable {pct(analysis.textScore)}</span>
            <span>Contours {pct(analysis.edgeScore)}</span>
            <span>Aplats {pct(analysis.flatScore)}</span>
            <span>Structure centrale {pct(analysis.centralScore)}</span>
          </div>
        </div>
      )}

      <div className="scene-preset-grid">
        {presetIds.map((id) => {
          const preset = SCENE_PRESETS[id];
          return (
            <button
              key={id}
              type="button"
              disabled={disabled}
              className={value === id ? "scene-preset active" : "scene-preset"}
              onClick={() => onChange(id)}
            >
              <strong>{preset.label}</strong>
              <span>{preset.description}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
