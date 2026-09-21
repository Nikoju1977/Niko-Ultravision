import type { PrecisionRestoreSettings } from "./lib/precisionRestore";

export type { PrecisionRestoreSettings } from "./lib/precisionRestore";

interface Props {
  disabled?: boolean;
  value: PrecisionRestoreSettings;
  onChange: (next: PrecisionRestoreSettings) => void;
}

function percent(value: number): number {
  return Math.round(value * 100);
}

export default function PrecisionRestoreControl({ disabled = false, value, onChange }: Props) {
  return (
    <div className="precision-box">
      <div className="deep-focus-head">
        <div>
          <strong>UltraVision Precision Restore</strong>
          <span>Texte · contours fins · protection des aplats · anti-halo</span>
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
        Le moteur renforce prioritairement les structures déjà présentes qui ressemblent à du texte ou à des bords
        d’objets. Les zones plates sont protégées afin de limiter le bruit et les halos.
      </p>

      <div className="precision-controls">
        <label>
          <span>Force</span>
          <strong>{percent(value.strength)} %</strong>
          <input
            type="range"
            min={15}
            max={85}
            step={1}
            value={percent(value.strength)}
            disabled={disabled || !value.enabled}
            onChange={(event) => onChange({ ...value, strength: Number(event.target.value) / 100 })}
          />
        </label>

        <label>
          <span>Priorité texte</span>
          <strong>{percent(value.textBias)} %</strong>
          <input
            type="range"
            min={20}
            max={100}
            step={1}
            value={percent(value.textBias)}
            disabled={disabled || !value.enabled}
            onChange={(event) => onChange({ ...value, textBias: Number(event.target.value) / 100 })}
          />
        </label>

        <label>
          <span>Priorité contours</span>
          <strong>{percent(value.edgeBias)} %</strong>
          <input
            type="range"
            min={20}
            max={100}
            step={1}
            value={percent(value.edgeBias)}
            disabled={disabled || !value.enabled}
            onChange={(event) => onChange({ ...value, edgeBias: Number(event.target.value) / 100 })}
          />
        </label>

        <label>
          <span>Protection aplats</span>
          <strong>{percent(value.flatProtection)} %</strong>
          <input
            type="range"
            min={20}
            max={100}
            step={1}
            value={percent(value.flatProtection)}
            disabled={disabled || !value.enabled}
            onChange={(event) => onChange({ ...value, flatProtection: Number(event.target.value) / 100 })}
          />
        </label>

        <label>
          <span>Seuil anti-bruit</span>
          <strong>{percent(value.noiseGate)} %</strong>
          <input
            type="range"
            min={0}
            max={60}
            step={1}
            value={percent(value.noiseGate)}
            disabled={disabled || !value.enabled}
            onChange={(event) => onChange({ ...value, noiseGate: Number(event.target.value) / 100 })}
          />
        </label>
      </div>
    </div>
  );
}
