import { useEffect, useMemo, useState } from "react";
import { compareImageQuality, type QualityComparison } from "./lib/qualityComparator";

interface Props {
  source: Blob;
  output: Blob;
}

function signed(value: number, digits = 1): string {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(digits)} %`;
}

function metricTone(value: number, neutralBand = 1): "good" | "neutral" | "warning" {
  if (value > neutralBand) return "good";
  if (value < -neutralBand) return "warning";
  return "neutral";
}

export default function ComparisonPanel({ source, output }: Props) {
  const [report, setReport] = useState<QualityComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState(50);
  const [showDifference, setShowDifference] = useState(false);

  useEffect(() => {
    let alive = true;
    setReport(null);
    setError(null);

    void compareImageQuality(source, output)
      .then((next) => {
        if (alive) setReport(next);
      })
      .catch((reason) => {
        if (alive) {
          setError(reason instanceof Error ? reason.message : "Comparaison indisponible.");
        }
      });

    return () => {
      alive = false;
    };
  }, [source, output]);

  const summary = useMemo(() => {
    if (!report) return null;

    if (report.sharpnessGainPercent >= 8 && report.edgeGainPercent >= 2) {
      return "Gain de micro-détail mesurable. Vérifie visuellement les halos et textures artificielles.";
    }
    if (report.sharpnessGainPercent >= 2) {
      return "Gain léger à modéré. Le changement existe, mais peut rester subtil à taille normale.";
    }
    if (report.sharpnessGainPercent > -2) {
      return "Netteté mesurée quasi inchangée. Le traitement a peu modifié le micro-détail.";
    }
    return "La netteté mesurée a diminué. Réduis la restauration ou change de profil.";
  }, [report]);

  if (error) {
    return (
      <section className="panel compare-panel">
        <span className="kicker">04 · QUALITY LAB</span>
        <h2>Avant / après</h2>
        <div className="warning-card">{error}</div>
      </section>
    );
  }

  if (!report) {
    return (
      <section className="panel compare-panel">
        <span className="kicker">04 · QUALITY LAB</span>
        <h2>Avant / après</h2>
        <div className="empty-result">
          <strong>Analyse objective en cours…</strong>
          <span>Mesure du micro-détail, des contours et de la fidélité structurelle.</span>
        </div>
      </section>
    );
  }

  return (
    <section className="panel compare-panel">
      <div className="panel-title-row">
        <div>
          <span className="kicker">04 · QUALITY LAB</span>
          <h2>Avant / après mesuré</h2>
        </div>
        <button
          type="button"
          className={showDifference ? "secondary-button active" : "secondary-button"}
          onClick={() => setShowDifference((value) => !value)}
        >
          {showDifference ? "Voir le comparateur" : "Carte de différence"}
        </button>
      </div>

      <div className="quality-summary">
        <strong>{summary}</strong>
        <span>
          Les scores quantifient des changements du signal. Ils ne garantissent pas qu'un détail reconstruit corresponde
          réellement à la scène originale.
        </span>
      </div>

      {showDifference ? (
        <div className="difference-view">
          <img src={report.differencePreview} alt="Carte des différences entre source et master" />
          <span>Plus la zone est lumineuse, plus le master diffère de la source.</span>
        </div>
      ) : (
        <div className="compare-stage" style={{ aspectRatio: `${report.width} / ${report.height}` }}>
          <img className="compare-base" src={report.sourcePreview} alt="Image source" />
          <img
            className="compare-overlay"
            src={report.outputPreview}
            alt="Image UltraVision"
            style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
          />
          <div className="compare-divider" style={{ left: `${position}%` }} />
          <span className="compare-label before">SOURCE</span>
          <span className="compare-label after">ULTRAVISION</span>
          <input
            className="compare-slider"
            type="range"
            min={0}
            max={100}
            value={position}
            aria-label="Position du comparateur avant après"
            onChange={(event) => setPosition(Number(event.target.value))}
          />
        </div>
      )}

      <div className="quality-grid">
        <div className={`quality-metric ${metricTone(report.sharpnessGainPercent, 2)}`}>
          <span>Micro-détail</span>
          <strong>{signed(report.sharpnessGainPercent)}</strong>
          <small>variance du Laplacien</small>
        </div>
        <div className={`quality-metric ${metricTone(report.edgeGainPercent, 1)}`}>
          <span>Contours</span>
          <strong>{signed(report.edgeGainPercent)}</strong>
          <small>énergie des bords</small>
        </div>
        <div className="quality-metric neutral">
          <span>Contraste</span>
          <strong>{signed(report.contrastChangePercent)}</strong>
          <small>écart-type luminance</small>
        </div>
        <div className="quality-metric neutral">
          <span>SSIM</span>
          <strong>{report.ssim.toFixed(4)}</strong>
          <small>similarité structurelle par blocs</small>
        </div>
        <div className="quality-metric neutral">
          <span>PSNR</span>
          <strong>{report.psnr >= 98 ? "∞" : `${report.psnr.toFixed(1)} dB`}</strong>
          <small>écart source / master</small>
        </div>
        <div className="quality-metric neutral">
          <span>Pixels modifiés</span>
          <strong>{report.changedPixelsPercent.toFixed(1)} %</strong>
          <small>seuil luminance ≥ 3/255</small>
        </div>
      </div>
    </section>
  );
}
