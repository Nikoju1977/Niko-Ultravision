/**
 * Annulation coopérative des traitements longs (image, vidéo, Aura-Vision).
 *
 * Un seul traitement actif à la fois dans l'app : un jeton global suffit.
 * Les boucles longues appellent throwIfCancelled() entre deux unités de
 * travail (tuile IA, image vidéo…) ; les pipelines externes (mediabunny)
 * s'abonnent via onCancel() pour être arrêtés proprement.
 */

export class CancelledError extends Error {
  constructor() {
    super("Traitement annulé.");
    this.name = "CancelledError";
  }
}

export function isCancelledError(reason: unknown): reason is CancelledError {
  return reason instanceof CancelledError ||
    (reason instanceof Error && reason.name === "CancelledError");
}

let cancelled = false;
const listeners = new Set<() => void>();

/** À appeler au début de chaque traitement : réarme le jeton. */
export function beginJob(): void {
  cancelled = false;
  listeners.clear();
}

export function requestCancel(): void {
  if (cancelled) return;
  cancelled = true;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      /* un abonné défaillant ne doit pas bloquer les autres */
    }
  }
}

export function isCancelled(): boolean {
  return cancelled;
}

export function throwIfCancelled(): void {
  if (cancelled) throw new CancelledError();
}

/** Abonnement à l'annulation ; retourne la fonction de désabonnement. */
export function onCancel(listener: () => void): () => void {
  if (cancelled) {
    listener();
    return () => undefined;
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}
