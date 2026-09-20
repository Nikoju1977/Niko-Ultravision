import { useEffect, useMemo, useState } from "react";
import { calculateOutputSize, formatDimensions, megapixels, type Size, type TargetId } from "./lib/geometry";
import { assessImageTarget, enhanceImage, type ImageFormat } from "./lib/imageEnhancer";
import { PROFILES, type ProfileId } from "./lib/profiles";
import { enhanceVideo } from "./lib/videoEnhancer";

type MediaMode = "image" | "video";

type OutputState = {
  url: string;
  blob: Blob;
  size: Size;
  note: string;
  frameRate?: number;
  frameRateDetected?: boolean;
} | null;

const IMAGE_TARGETS: Array<{ id: TargetId; label: string; hint: string }> = [
  { id: "original", label: "Original", hint: "même définition" },
  { id: "2k", label: "2K", hint: "2 048 px côté long" },
  { id: "4k", label: "4K", hint: "3 840 px côté long" },
  { id: "8k", label: "8K", hint: "7 680 px côté long" },
  { id: "16k", label: "16K", hint: "15 360 px · appareil puissant" },
  { id: "32k", label: "32K", hint: "30 720 px · limite matérielle probable" },
];

const VIDEO_TARGETS: Array<{ id: TargetId; label: string; hint: string }> = [
  { id: "original", label: "Original", hint: "même définition" },
  { id: "1080p", label: "1080p", hint: "1 920 px côté long" },
  { id: "2k", label: "2K", hint: "2 048 px côté long" },
  { id: "4k", label: "4K", hint: "limite locale fiable" },
];

function extensionFor(type: string): string {
  if (type.includes("png")) return "png";
  if (type.includes("jpeg")) return "jpg";
  if (type.includes("webp")) return "webp";
  if (type.includes("mp4")) return "mp4";
  return "webm";
}

async function inspectMedia(file: File): Promise<{ mode: MediaMode; size: Size }> {
  if (file.type.startsWith("image/")) {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return { mode: "image", size };
  }

  if (file.type.startsWith("video/")) {
    const url = URL.createObjectURL(file);
    try {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.src = url;
      await new Promise<void>((resolve, reject) => {
        video.addEventListener("loadedmetadata", () => resolve(), { once: true });
        video.addEventListener("error", () => reject(new Error("Vidéo illisible.")), { once: true });
      });
      return { mode: "video", size: { width: video.videoWidth, height: video.videoHeight } };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  throw new Error("Format non pris en charge. Utilise une image ou une vidéo.");
}

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [sourceSize, setSourceSize] = useState<Size | null>(null);
  const [mode, setMode] = useState<MediaMode>("image");
  const [profile, setProfile] = useState<ProfileId>("fidelity");
  const [target, setTarget] = useState<TargetId>("4k");
  const [format, setFormat] = useState<ImageFormat>("image/png");
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [output, setOutput] = useState<OutputState>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Prêt");
  const [error, setError] = useState<string | null>(null);

  const targets = mode === "image" ? IMAGE_TARGETS : VIDEO_TARGETS;
  const predicted = useMemo(() => {
    if (!sourceSize) return null;
    return calculateOutputSize(sourceSize.width, sourceSize.height, target);
  }, [sourceSize, target]);

  const imageAssessment = useMemo(() => {
    if (mode !== "image" || !sourceSize) return null;
    return assessImageTarget(sourceSize, target);
  }, [mode, sourceSize, target]);

  useEffect(() => {
    if (!file) return;
    const next = URL.createObjectURL(file);
    setSourceUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);

  useEffect(() => {
    return () => {
      if (output?.url) URL.revokeObjectURL(output.url);
    };
  }, [output]);

  async function handleFile(next: File | null) {
    if (!next) return;
    setError(null);
    setOutput((previous) => {
      if (previous?.url) URL.revokeObjectURL(previous.url);
      return null;
    });
    try {
      const inspected = await inspectMedia(next);
      setFile(next);
      setMode(inspected.mode);
      setSourceSize(inspected.size);
      setTarget(inspected.mode === "video" ? "1080p" : "4k");
      setStatus("Source analysée localement");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Impossible de lire ce fichier.");
    }
  }

  async function runEnhancement() {
    if (!file || !sourceSize) return;
    setBusy(true);
    setError(null);
    setProgress(0);
    setOutput((previous) => {
      if (previous?.url) URL.revokeObjectURL(previous.url);
      return null;
    });

    try {
      if (mode === "image") {
        const result = await enhanceImage(file, target, profile, format, (value, label) => {
          setProgress(value);
          setStatus(label);
        });
        const url = URL.createObjectURL(result.blob);
        setOutput({
          url,
          blob: result.blob,
          size: result.size,
          note: result.sharpenApplied
            ? "Agrandissement progressif + accentuation locale légère."
            : "Agrandissement progressif haute qualité ; accentuation désactivée sur très grande image pour préserver la mémoire.",
        });
      } else {
        const result = await enhanceVideo(file, target, profile, (value, label) => {
          setProgress(value);
          setStatus(label);
        });
        const url = URL.createObjectURL(result.blob);
        setOutput({
          url,
          blob: result.blob,
          size: result.size,
          note: result.audioPreserved
            ? "Vidéo rééchantillonnée localement avec piste audio préservée."
            : "Vidéo rééchantillonnée localement. Le navigateur n'a pas permis de préserver l'audio.",
        });
      }
      setProgress(1);
      setStatus("Master prêt");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Le traitement a échoué.");
      setStatus("Erreur");
    } finally {
      setBusy(false);
    }
  }

  function downloadOutput() {
    if (!output || !file) return;
    const a = document.createElement("a");
    a.href = output.url;
    const base = file.name.replace(/\.[^.]+$/, "") || "ultravision";
    a.download = `${base}-ultravision.${extensionFor(output.blob.type)}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">NIKO STUDIO · LOCAL MASTERING</div>
          <h1>Niko UltraVision Pro</h1>
          <p className="subtitle">Amélioration locale d’images et de vidéos. Aucun fichier n’est envoyé vers un service externe.</p>
        </div>
        <div className="privacy-badge"><span /> 100 % local</div>
      </header>

      <section className="hero-grid">
        <article className="panel source-panel">
          <div className="panel-title-row">
            <div>
              <span className="kicker">01 · SOURCE</span>
              <h2>Importer un master</h2>
            </div>
            <span className="lock">Fidelity Lock</span>
          </div>

          <label className="dropzone">
            <input
              type="file"
              accept="image/*,video/*"
              onChange={(event) => void handleFile(event.target.files?.[0] ?? null)}
              disabled={busy}
            />
            {sourceUrl ? (
              mode === "image" ? <img src={sourceUrl} alt="Source" /> : <video src={sourceUrl} controls playsInline />
            ) : (
              <div className="dropzone-empty">
                <div className="upload-glyph">＋</div>
                <strong>Choisir une image ou une vidéo</strong>
                <span>Traitement effectué sur cet appareil</span>
              </div>
            )}
          </label>

          <div className="metrics">
            <div><span>Type</span><strong>{file ? mode.toUpperCase() : "—"}</strong></div>
            <div><span>Source</span><strong>{formatDimensions(sourceSize)}</strong></div>
            <div><span>Cible</span><strong>{formatDimensions(predicted)}</strong></div>
            <div><span>Ratio</span><strong>{sourceSize ? (sourceSize.width / sourceSize.height).toFixed(3) : "—"}</strong></div>
          </div>
        </article>

        <aside className="panel controls-panel">
          <span className="kicker">02 · MASTERING</span>
          <h2>Paramètres</h2>

          <div className="control-block">
            <label>Profil</label>
            <div className="profile-grid">
              {(Object.keys(PROFILES) as ProfileId[]).map((id) => (
                <button
                  key={id}
                  type="button"
                  className={profile === id ? "choice active" : "choice"}
                  onClick={() => setProfile(id)}
                  disabled={busy}
                >
                  <strong>{PROFILES[id].label}</strong>
                  <span>{PROFILES[id].description}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="control-block">
            <label>Définition cible</label>
            <div className="target-grid">
              {targets.map((item) => {
                const availability =
                  mode === "image" && sourceSize ? assessImageTarget(sourceSize, item.id) : null;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={target === item.id ? "target active" : "target"}
                    onClick={() => setTarget(item.id)}
                    disabled={busy || availability?.supported === false}
                    title={availability?.reason}
                  >
                    <strong>{item.label}</strong>
                    <span>{availability?.supported === false ? "indisponible sur cet appareil" : item.hint}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {mode === "image" && (
            <div className="control-block">
              <label htmlFor="format">Format d’export</label>
              <select id="format" value={format} onChange={(event) => setFormat(event.target.value as ImageFormat)} disabled={busy}>
                <option value="image/png">PNG · sans perte</option>
                <option value="image/webp">WebP · haute qualité</option>
                <option value="image/jpeg">JPEG · qualité 96 %</option>
              </select>
            </div>
          )}

          <div className="fidelity-card">
            <strong>Géométrie verrouillée</strong>
            <span>Pas de crop automatique. Pas d’étirement. Le ratio source est recalculé mathématiquement à chaque cible.</span>
          </div>

          {imageAssessment && !imageAssessment.supported && (
            <div className="warning-card">{imageAssessment.reason}</div>
          )}

          {imageAssessment?.supported && predicted && megapixels(predicted) > 70 && (
            <div className="warning-card">
              Cette cible représente {megapixels(predicted).toFixed(1)} MP. Le traitement est autorisé, mais restera exigeant pour la mémoire locale.
            </div>
          )}

          <button className="run-button" type="button" onClick={() => void runEnhancement()} disabled={!file || busy || imageAssessment?.supported === false}>
            {busy ? "Traitement en cours…" : "Créer le master local"}
          </button>

          <div className="progress-wrap" aria-live="polite">
            <div className="progress-track"><span style={{ width: `${Math.round(progress * 100)}%` }} /></div>
            <div className="progress-label"><span>{status}</span><strong>{Math.round(progress * 100)} %</strong></div>
          </div>

          {error && <div className="error-card">{error}</div>}
        </aside>
      </section>

      <section className="panel result-panel">
        <div className="panel-title-row">
          <div>
            <span className="kicker">03 · RESULTAT</span>
            <h2>Master exportable</h2>
          </div>
          {output && <button className="secondary-button" type="button" onClick={downloadOutput}>Télécharger</button>}
        </div>

        {output ? (
          <div className="result-grid">
            <div className="preview-frame">
              {mode === "image" ? <img src={output.url} alt="Résultat UltraVision" /> : <video src={output.url} controls playsInline />}
            </div>
            <div className="result-copy">
              <div className="success-mark">✓</div>
              <h3>Master terminé</h3>
              <p>{output.note}</p>
              <dl>
                <div><dt>Résolution</dt><dd>{formatDimensions(output.size)}</dd></div>
                <div><dt>Taille</dt><dd>{(output.blob.size / 1024 / 1024).toFixed(1)} Mo</dd></div>
                <div><dt>Traitement</dt><dd>Local navigateur</dd></div>
              </dl>
            </div>
          </div>
        ) : (
          <div className="empty-result">
            <strong>Aucun master créé</strong>
            <span>Importe un fichier, choisis une cible puis lance le traitement.</span>
          </div>
        )}
      </section>

      <section className="truth-panel">
        <h2>Ce que fait réellement cette version</h2>
        <p>
          UltraVision utilise ici les API natives du navigateur : rééchantillonnage haute qualité par Canvas pour l’image et traitement vidéo via Canvas + MediaRecorder. Il n’invente pas de « nouveaux détails IA ». Les cibles extrêmes restent limitées par la mémoire et les capacités du navigateur. La vidéo locale est volontairement plafonnée à 4K.
        </p>
      </section>

      <footer>UltraVision Pro · moteur local indépendant · aucune dépendance Higgsfield</footer>
    </main>
  );
}
