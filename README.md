# Niko UltraVision Pro

Version autonome et gratuite de l'application UltraVision.

## Ce qui change

- aucune dépendance `@higgsfield/*` ;
- aucun appel API propriétaire pour le traitement ;
- images traitées localement dans le navigateur avec Canvas 2D ;
- vidéos traitées localement avec Canvas + MediaRecorder ;
- conservation mathématique du ratio source (`Fidelity Lock`) ;
- aucune donnée média envoyée vers un serveur par cette application.

## Limites réelles

Cette version locale effectue du rééchantillonnage et de l'accentuation, pas de super-résolution générative. Les très hautes définitions sont limitées par la mémoire du navigateur et de l'appareil. La vidéo locale est plafonnée à 4K pour rester raisonnablement fiable.

## Développement

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

Node.js 22.12+ est recommandé pour Vite 8.
