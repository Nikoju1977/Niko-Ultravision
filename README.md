# Niko UltraVision Pro

Application autonome de restauration et de rééchantillonnage local d'images et de vidéos.

## Garanties de cette version

- aucune dépendance `@higgsfield/*` ;
- aucun média envoyé vers une API distante par le moteur ;
- traitement image local avec Canvas 2D ;
- traitement vidéo local avec Canvas + MediaRecorder ;
- conservation du cadrage complet, sans crop automatique ;
- contrôle préalable de la mémoire avant les très hautes résolutions ;
- cadence vidéo source détectée lorsque `requestVideoFrameCallback` est disponible, avec sortie normalisée jusqu'à 60 i/s ;
- piste audio intégrée lorsque le navigateur expose correctement l'audio au pipeline local ;
- dépendances reproductibles via `package-lock.json` et `npm ci` ;
- audit de sécurité et build de production exécutés automatiquement par GitHub Actions.

## Résolutions

### Images

Les cibles vont jusqu'à 32K dans le modèle de dimensions, mais l'interface désactive automatiquement toute cible qui dépasse les limites sûres du navigateur ou de la mémoire de l'appareil. Cela évite de promettre un 16K/32K qu'un téléphone ne peut pas réellement produire.

### Vidéos

Le traitement local est limité à 4K. Le moteur privilégie la stabilité et refuse une sortie supérieure plutôt que de lancer un encodage susceptible de planter le navigateur.

## Limite importante

Cette version n'est pas une super-résolution générative. Elle effectue un rééchantillonnage haute qualité, des filtres de restauration légers et une accentuation locale. Elle ne fabrique pas de nouveaux détails comme un modèle Real-ESRGAN, HAT ou Topaz.

## Développement

```bash
npm ci
npm run dev
```

## Vérification

```bash
npm ci
npm audit --audit-level=high
npm run build
```

Node.js 22.12+ est requis.
