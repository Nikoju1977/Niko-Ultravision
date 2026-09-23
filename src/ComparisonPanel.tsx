import { useEffect, useMemo, useState } from "react";
import { compareImageQuality, type QualityComparison, type ZoneComparison } from "./lib/qualityComparator";

interface Props {
  source: Blob;
  output: Blob;
  /** Comparaison déjà calculée par le verrou final : aucun recalcul. */
  report?: QualityComparison;
}

type ViewMode = "compare" | "difference" | "text" | "edge" | "flat" | "central";

function signed(value: number, digits = 1): string {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(digits)} %`;
}

function metricTone(value: number, neutralBand = 1): "good" | "neutral" | "warning" {
  if (value > neutralBand) return "good";
  if (value < -neutralBand) return "warning";
  return "neutral";
}

function ZoneCard({ label, zone }: { label: string; zone: ZoneComparison }) {
  return (
    <div className={`quality-zone-card ${metricTone(zone.sharpnessGainPercent, 2)}`}>
      <strong>{label}</strong>
      <span>Couverture {zone.coveragePercent.toFixed(1)} %</span>
      <small>Micro-détail {signed(zone.sharpnessGainPercent)}</small>
      <small>Contours {signed(zone.edgeGainPercent)}</small>
      <small>Contraste {signed(zone.contrastChangePercent)}</small>
    </div>
  );
}

export default function ComparisonPanel({ source, output, report: precomputed }: Props) {
  const [report, setReport] = useState<QualityComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState(50);
  const [view, setView] = useState<ViewMode>("compare");

  useEffect(() => {
    let alive = true;
    setReport(null);
    setError(null);
    setView("compare");

    if (precomputed) {
      setReport(precomputed);
      return () => {
        alive = false;
      };
    }

    void compareImageQuality(source, output)
      .then((next) => {
        if (alive) setReport(next);
      })
      .catch((reason) => {
        if (alive) setError(reason instanceof Error ? reason.message : "Comparaison indisponible.");
      });

    return () => {
      alive = false;
    };
  }, [source, output, precomputed]);

  const summary = useMemo(() => {
    if (!report) return null;

    if (report.sharpnessGainPercent >= 8 && report.edgeGainPercent >= 2) {
      return "Gain de micro-détail mesurable. Vérifie les heatmaps pour confirmer que le gain porte sur les zones utiles.";
    }
    if (report.sharpnessGainPercent >= 2) {
      return "Gain léger à modéré. Les scores par zone permettent de voir où le traitement agit réellement.";
    }
    if (report.sharpnessGainPercent > -2) {
      return "Netteté mesurée quasi inchangée. Le traitement a peu modifié le micro-détail.";
    }
    return "La netteté mesurée a diminué. Réduis la restauration ou change de preset.";
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
          <span>Mesure globale et analyse séparée texte / contours / aplats / structure centrale.</span>
        </div>
      </section>
    );
  }

  const heatmap =
    view === "text"
      ? { src: report.textHeatmap, label: "Texte probable · jaune" }
      : view === "edge"
        ? { src: report.edgeHeatmap, label: "Contours · cyan" }
        : view === "flat"
          ? { src: report.flatHeatmap, label: "Aplats · bleu" }
          : view === "central"
            ? { src: report.centralHeatmap, label: "Structure centrale · vert" }
            : null;

  return (
    <section className="panel compare-panel">
      <div className="panel-title-row">
        <div>
          <span className="kicker">04 · QUALITY LAB</span>
          <h2>Avant / après mesuré</h2>
        </div>
      </div>

      <div className="quality-summary">
        <strong>{summary}</strong>
        <span>
          Les scores mesurent le signal, pas la vérité sémantique. Les zones “texte” sont détectées par structure fine,
          sans OCR, et la zone centrale est une pondération géométrique — pas une segmentation d’objet.
        </span>
      </div>

      <div className="quality-view-tabs">
        {([
          ["compare", "Avant / après"],
          ["difference", "Différence"],
          ["text", "Texte"],
          ["edge", "Contours"],
          ["flat", "Aplats"],
          ["central", "Centre"],
        ] as Array<[ViewMode, string]>).map(([id, label]) => (
          <button
            type="button"
            key={id}
            className={view === id ? "secondary-button active" : "secondary-button"}
            onClick={() => setView(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {view === "compare" ? (
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
      ) : view === "difference" ? (
        <div className="difference-view">
          <img src={report.differencePreview} alt="Carte des différences entre source et master" />
          <span>Plus la zone est lumineuse, plus le master diffère de la source. Différence ne signifie pas forcément amélioration.</span>
        </div>
      ) : heatmap ? (
        <div className="difference-view">
          <img src={heatmap.src} alt={heatmap.label} />
          <span>{heatmap.label}. Intensité élevée = zone davantage détectée par l’heuristique Scene Precision.</span>
        </div>
      ) : null}

      <div className="quality-grid">
        <div className={`quality-metric ${metricTone(report.sharpnessGainPercent, 2)}`}>
          <span>Micro-détail global</span>
          <strong>{signed(report.sharpnessGainPercent)}</strong>
          <small>variance du Laplacien</small>
        </div>
        <div className={`quality-metric ${metricTone(report.edgeGainPercent, 1)}`}>
          <span>Contours globaux</span>
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

      <div className="quality-zone-grid">
        <ZoneCard label="Texte probable" zone={report.textZone} />
        <ZoneCard label="Contours structurés" zone={report.edgeZone} />
        <ZoneCard label="Aplats" zone={report.flatZone} />
        <ZoneCard label="Structure centrale" zone={report.centralZone} />
      </div>
    </section>
  );
}
