# Niko UltraVision Pro

Application autonome de restauration et de rééchantillonnage local d'images et de vidéos.

## Deux moteurs, deux contrats différents

| Moteur | Ce qu'il fait | Ce qu'il ne fait pas |
|---|---|---|
| **Canvas** | Rééchantillonnage progressif haute qualité (facteur 2 max par passe), filtres de restauration légers, accentuation locale | N'invente aucun détail absent de la source |
| **IA locale** | Exécute un vrai réseau de super-résolution open source au format ONNX, par tuiles, sur l'appareil | Ne garantit pas la fidélité : un réseau génératif peut halluciner de la texture |

Le moteur IA repose sur **ONNX Runtime Web** (MIT), avec backend **WebGPU** si disponible,
sinon **WebAssembly**. Le binaire WASM est servi depuis les assets de l'application, pas
depuis un CDN tiers.

### Modèle

Par défaut : **Swin2SR classical x2** (Apache-2.0), export ONNX public.
L'URL est modifiable dans l'interface, et un fichier `.onnx` local peut être chargé à la
place — ce qui rend le mode IA utilisable entièrement hors ligne.

Le moteur est **agnostique du modèle** : le nom des entrées/sorties et le facteur
d'échelle sont lus sur la session ONNX au chargement, pas codés en dur. Tout modèle de
super-résolution à une entrée et une sortie NCHW fonctionne (Swin2SR, SwinIR, Real-ESRGAN,
EDSR). Les tuiles sont complétées au multiple de 8 par réplication de bord, pour les
architectures à fenêtre glissante.


## UltraVision Deep Focus 10+

Deep Focus est activé par défaut sur les images avec **10 plans de focalisation** et peut
être réglé de 10 à 24 plans. Le moteur mesure le déficit local de micro-contraste,
quantifie l'image en bandes de focalisation, puis applique une restauration
contrast-limited différente selon chaque bande. Une carte colorée permet de visualiser
les zones déjà nettes et celles qui demandent davantage de restauration.

Ce mode est conçu pour augmenter la **profondeur de netteté perceptuelle** sans appliquer
un sharpen global uniforme. Il fonctionne avant la super-résolution afin que le réseau
ONNX reçoive une source déjà restaurée.

Point important : sur une image 2D unique, Deep Focus ne mesure pas une profondeur
physique en mètres et ne peut pas retrouver fidèlement des détails optiques totalement
absents d'une zone très hors focus. Il améliore les informations réellement présentes,
sans présenter une reconstruction hypothétique comme une donnée originale.

Pour préserver la mémoire sur mobile, Deep Focus est limité à 10 MP en entrée. Au-delà,
le reste du pipeline continue normalement et l'interface indique que l'étape a été
ignorée.


## Quality Lab : vérifier le gain réel

Après chaque master image, UltraVision affiche désormais un comparateur **avant / après**
interactif et mesure le signal à résolution commune :

- gain de micro-détail par variance du Laplacien ;
- variation d'énergie des contours ;
- variation de contraste ;
- **SSIM par blocs** pour la similarité structurelle ;
- **PSNR** pour l'écart source/master ;
- pourcentage de pixels réellement modifiés ;
- carte de différence visualisant les zones où le master diverge de la source.

Ces métriques évitent de confondre un simple changement de conteneur ou de compression
avec une amélioration réelle. Elles ne certifient toutefois pas qu'un détail généré par
une IA correspond à la scène originale : une hausse de netteté doit toujours être
interprétée avec la comparaison visuelle.

## Vie privée

- Aucune dépendance `@higgsfield/*`.
- Dépendances : `onnxruntime-web` (MIT), `mediabunny` (MPL-2.0). La MPL-2.0 est un
  copyleft par fichier : l'utiliser comme dépendance n'oblige à rien, seules des
  modifications de ses propres fichiers devraient être repartagées.
- **Aucun média n'est envoyé nulle part.** Images et vidéos sont traitées sur l'appareil.
- Seuls les **poids du modèle** transitent par le réseau, une seule fois, si tu choisis le
  chargement par URL. Le chargement d'un `.onnx` local supprime même cet appel.

## Résolutions

### Images

Cibles : Original, 2K, 4K, 8K, 16K.

Le **32K a été retiré**. Ce n'était pas une limitation de prudence : un canvas 32K
représente plus de 500 mégapixels, au-delà de la surface maximale de Chrome (~268 MP) et
de Firefox (~472 MP). Aucun navigateur actuel ne peut l'allouer. Le proposer revenait à
afficher un bouton qui ne pouvait pas fonctionner.

Le 16K reste proposé, mais sous deux contrôles :

1. la **dimension maximale du canvas est réellement mesurée** au démarrage (et non déduite
   de `navigator.deviceMemory`) ;
2. juste avant le traitement, l'allocation exacte est **testée** — on écrit puis relit un
   pixel dans le coin opposé. Un navigateur qui clampe silencieusement échoue ici, et
   l'application refuse proprement au lieu de produire une image noire.

Le budget mémoire, lui, reste une **estimation** assumée comme telle : il n'existe pas
d'API fiable pour la mémoire réellement disponible. Les messages d'erreur distinguent une
limite mesurée d'une limite estimée.

### Vidéos

Cibles : Original, 1080p, 2K, 4K, 8K.

Deux pipelines, choisis à l'exécution selon le navigateur :

**WebCodecs (Chrome, Edge, Safari 16.4+)** — le fichier source est démultiplexé, décodé,
retraité et réencodé hors temps réel via [mediabunny](https://mediabunny.dev) (MPL-2.0).
Horodatage exact, **aucune image perdue**, piste audio recopiée sans réencodage quand le
conteneur le permet.

**MediaRecorder (repli)** — encodage en temps réel sur `captureStream`, plafonné à 4K.
Des images peuvent être perdues si le rendu prend du retard, et la qualité n'est réglable
que par un débit cible. C'est signalé explicitement dans l'interface : ce n'est pas le même
produit.

#### Codecs

Aucun codec n'est codé en dur. À chaque traitement, l'application demande au navigateur la
liste des codecs **réellement encodables pour la résolution et la cadence visées**, puis
choisit le meilleur selon l'intention :

| Intention | Préférence | Images clés |
|---|---|---|
| Copie directe | aucun réencodage | — |
| Mezzanine intra | HEVC → H.264 → AV1 → VP9 | toutes |
| Master | AV1 → HEVC → VP9 → H.264 | toutes les 2 s |
| Diffusion | AV1 → HEVC → VP9 → H.264 → VP8 | toutes les 5 s |
| Compatibilité | H.264 → VP8 → VP9 | toutes les 5 s |

Les codecs écartés sont listés dans le résultat avec leur raison. Le conteneur suit le
codec : MP4 pour H.264/HEVC/AV1, WebM pour VP8/VP9.

#### Sur les « codecs pro »

Soyons précis, parce que c'est le point où l'on ment facilement.

**ProRes et DNxHR ne sont pas encodables dans un navigateur.** Aucune implémentation de
WebCodecs n'expose d'encodeur ProRes, et en écrire un serait un projet à part entière.
mediabunny sait *démultiplexer et remultiplexer* du ProRes : un master ProRes en entrée
peut donc être recopié tel quel en mode Copie directe, mais pas produit.

Ce qui rend ProRes intéressant en post-production, c'est surtout son caractère **intra
pur** : chaque image est indépendante, donc le montage image par image est exact et il n'y
a pas de dépendance inter-image à recalculer au scrubbing. Cette propriété-là, le mode
**Mezzanine intra** la reproduit avec les codecs disponibles, en forçant
`keyFrameInterval: 0`. Fichier lourd, comportement de montage équivalent.

**Le 10 bits n'est pas accessible non plus** par ce chemin : l'API de conversion de
mediabunny 1.58 n'expose pas `fullCodecString`, donc pas moyen de demander un
`av01.0.08M.10` ou un HEVC Main10. La sortie est en 8 bits. C'est la limite la plus
gênante pour un usage étalonnage, et elle est structurelle, pas un oubli.

## Limites connues

- Sortie vidéo en **8 bits** uniquement (voir plus haut).
- Le repli MediaRecorder reste plafonné à 4K ; la cible 8K exige WebCodecs.
- L'inférence IA est plafonnée à **8 MP en entrée**, avec avertissement au-delà de 2 MP.
  Sans WebGPU, compter plusieurs minutes.
- Le mode multi-thread WASM exige l'isolation cross-origin (COOP/COEP). Sans elle,
  l'inférence tourne en mono-thread. C'est un choix : activer COOP/COEP casserait d'autres
  appels cross-origin.
- Le build embarque deux binaires WASM d'ONNX Runtime (~55 Mo dans `dist/`). Un seul est
  téléchargé par le navigateur à l'exécution ; l'autre est un artefact de build.

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

Node.js 22.12+ est requis. Dépendances verrouillées par `package-lock.json`
(`lockfileVersion` 3), audit et build de production exécutés par GitHub Actions.

## Ce qui reste à valider en conditions réelles

Le tuilage IA (couverture exacte, absence de couture, aucun débordement) et la
normalisation des cadences sont vérifiés par calcul. Le code compile contre les types réels
de mediabunny et d'ONNX Runtime Web, et le build de production passe.

En revanche, **l'inférence IA et l'encodage WebCodecs doivent être testés dans un vrai
navigateur** : disponibilité de l'URL du modèle : disponibilité de l'URL du modèle, compatibilité de son
graphe, et temps de calcul effectif sur ta machine.
