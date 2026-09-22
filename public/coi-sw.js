/*
 * Niko UltraVision — service worker d'isolation cross-origin (COOP/COEP).
 *
 * GitHub Pages ne permet pas d'envoyer ces en-têtes : ce service worker les
 * ajoute aux réponses same-origin. Résultat : crossOriginIsolated === true,
 * SharedArrayBuffer disponible, inférence ONNX WASM multi-thread.
 *
 * Les requêtes cross-origin (modèles Hugging Face, API) ne sont pas touchées :
 * elles passent en CORS, ce que COEP require-corp accepte.
 *
 * Désactivation d'urgence : ouvrir l'app avec ?coi=0
 */
const VERSION = "coi-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("message", (event) => {
  if (event.data === "coi-unregister") {
    self.registration.unregister().then(() => self.clients.matchAll()).then((clients) => {
      clients.forEach((client) => client.navigate(client.url));
    });
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.cache === "only-if-cached" && request.mode !== "same-origin") return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(request).then((response) => {
      if (response.status === 0 || response.type === "opaque") return response;
      const headers = new Headers(response.headers);
      headers.set("Cross-Origin-Embedder-Policy", "require-corp");
      headers.set("Cross-Origin-Opener-Policy", "same-origin");
      headers.set("Cross-Origin-Resource-Policy", "same-origin");
      headers.set("X-UltraVision-SW", VERSION);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }),
  );
});
