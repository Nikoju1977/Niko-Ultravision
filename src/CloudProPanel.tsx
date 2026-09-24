import { useMemo, useState } from "react";
import type { Size } from "./lib/geometry";
import {
  cloudProOutputSupported,
  getCloudProEndpoint,
  getCloudProToken,
  runCloudProRestoration,
  setCloudProEndpoint,
  setCloudProToken,
  type CloudProRunResult,
} from "./lib/cloudPro";

interface CloudProPanelProps {
  source: File;
  localMaster: Blob;
  targetSize: Size;
  disabled?: boolean;
  onAccepted: (result: CloudProRunResult) => void;
}

export default function CloudProPanel({
  source,
  localMaster,
  targetSize,
  disabled = false,
  onAccepted,
}: CloudProPanelProps) {
  const [endpoint, setEndpoint] = useState(
    () => getCloudProEndpoint() ?? "",
  );
  const [token, setToken] = useState(
    () => getCloudProToken(),
  );
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [lastAccepted, setLastAccepted] = useState<boolean | null>(
    null,
  );

  const supported = useMemo(
    () => cloudProOutputSupported(targetSize),
    [targetSize],
  );
  const configured =
    Boolean(endpoint.trim()) && Boolean(token.trim());

  async function run() {
    if (!configured || !supported || disabled || busy) return;

    setCloudProEndpoint(endpoint);
    setCloudProToken(token);
    setBusy(true);
    setStatus("Cloud Pro · préparation");
    setProgress(0);
    setLastAccepted(null);

    try {
      const result = await runCloudProRestoration({
        source,
        localMaster,
        targetSize,
        endpoint,
        accessToken: token,
        onProgress: (value, label) => {
          setProgress(value);
          setStatus(label);
        },
      });
      setLastAccepted(result.accepted);
      setStatus(
        result.reason +
          ` · ${(result.uploadBytes / 1024 / 1024).toFixed(2)} Mo envoyés · ${(result.elapsedMs / 1000).toFixed(1)} s.`,
      );
      if (result.accepted) onAccepted(result);
    } catch (reason) {
      setLastAccepted(false);
      setStatus(
        reason instanceof Error
          ? reason.message
          : "Cloud Pro a échoué.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="cloud-pro-panel">
      <summary>
        <span>Cloud Pro · GPT Image 2.5</span>
        <small>
          {configured
            ? "optionnel · comparaison automatique"
            : "configuration serveur requise"}
        </small>
      </summary>

      <div className="cloud-pro-body">
        <p className="model-note">
          Ce mode est volontairement séparé du master local. Il envoie une
          copie réduite de la photo vers ton endpoint sécurisé, puis compare le
          résultat cloud au master local. Le cloud ne remplace le master que
          s'il gagne le duel de fidélité, détail et couleur.
        </p>

        {!supported && (
          <div className="warning-card">
            Cloud Pro est limité aux sorties ≤ 4K / 8,29 MP. Le master local
            reste la référence pour cette définition.
          </div>
        )}

        <label className="cloud-pro-field">
          <span>Endpoint sécurisé</span>
          <input
            type="url"
            value={endpoint}
            placeholder="https://ton-proxy.vercel.app/api/cloud-pro"
            autoComplete="off"
            disabled={busy}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setEndpoint(value);
              setCloudProEndpoint(value);
            }}
          />
        </label>

        <label className="cloud-pro-field">
          <span>Token d'accès au proxy</span>
          <input
            type="password"
            value={token}
            placeholder="Token Cloud Pro — jamais la clé OpenAI"
            autoComplete="off"
            disabled={busy}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setToken(value);
              setCloudProToken(value);
            }}
          />
        </label>

        <div className="warning-card cloud-privacy">
          La clé <code>OPENAI_API_KEY</code> doit rester exclusivement sur le
          serveur. N'entre jamais une clé OpenAI dans cette page. Le token
          ci-dessus sert seulement à protéger ton proxy et reste dans la
          session du navigateur.
        </div>

        <button
          type="button"
          className="secondary-button cloud-pro-run"
          disabled={
            disabled ||
            busy ||
            !supported ||
            !configured
          }
          onClick={() => void run()}
        >
          {busy
            ? "Cloud Pro · traitement…"
            : "Envoyer au Cloud Pro et garder le meilleur"}
        </button>

        {busy && (
          <div className="progress-wrap">
            <div className="progress-track">
              <span
                style={{
                  width: `${Math.round(progress * 100)}%`,
                }}
              />
            </div>
          </div>
        )}

        {status && (
          <div
            className={
              lastAccepted === true
                ? "model-status cloud-result-ok"
                : lastAccepted === false
                  ? "warning-card"
                  : "model-status"
            }
          >
            {status}
          </div>
        )}
      </div>
    </details>
  );
}
