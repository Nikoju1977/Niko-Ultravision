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


## Moteur IA local v5 — automatique, isolé, multi-thread

- **Binaire WASM corrigé** : le bundle `onnxruntime-web/webgpu` 1.30 utilise la glue *asyncify* ; l'app charge désormais `ort-wasm-simd-threaded.asyncify.wasm` (l'ancien binaire *jsep* faisait planter l'initialisation du runtime). Le binaire inutilisé (28 Mo) n'est plus déployé.
- **Web Worker** : session ONNX et conversions tenseur ↔ pixels hors du thread de l'interface.
- **Multi-thread** : `public/coi-sw.js` ajoute COOP/COEP sur GitHub Pages → `crossOriginIsolated`, jusqu'à 4 threads WASM. Désactivation d'urgence : `?coi=0`.
- **Replis testés en cascade** : worker multi-thread → worker mono-thread → thread principal ; WebGPU → WASM. La dernière configuration valide est réessayée en premier.
- **Cache local des poids** (Cache Storage), rempli uniquement après validation, purgé si corrompu.
- **IA automatique** : le modèle adapté (x2 mobile / x4 Pro Max) est chargé seul quand l'agrandissement le justifie. Le bouton *Canvas* force la fidélité stricte (aucune reconstruction neuronale).
- **AV-1X automatique** : déposer un `.avx` dans la zone source le décode directement.
- **Annulation** de tout traitement long, sans cascade de replis après annulation.

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


## Precision Restore : détail utile, bruit protégé

Precision Restore s'exécute après Deep Focus et avant la super-résolution. Il détecte
localement les structures fines déjà présentes, renforce prioritairement les zones
probables de texte et les contours d'objets, tout en protégeant les aplats et en
plafonnant les corrections pour limiter les halos.

Les réglages disponibles sont :

- force générale ;
- priorité texte ;
- priorité contours ;
- protection des aplats ;
- priorité centrale ;
- seuil anti-bruit.

Le moteur reste volontairement conservateur : il accentue des structures mesurées dans
l'image et ne présente pas une reconstruction hypothétique comme un détail original.
Comme Deep Focus, l'étape est limitée à 10 MP en entrée pour protéger la mémoire des
navigateurs mobiles.

## Depth Focus Precision v0.1

Depth Focus Precision ajoute une seconde couche de restauration orientée profondeur. Le
moteur construit une **carte de profondeur relative** à définition réduite, calcule une
**carte de confiance**, puis répartit la correction sur **10 à 16 plans Z**. Les paramètres
de correction sont interpolés entre les plans pour éviter les coutures visibles.

Le traitement combine :

- intensité différente selon le plan Z ;
- confiance locale pour éviter de forcer les zones ambiguës ;
- renforcement plus prudent des plans lointains ;
- protection accrue des zones peu structurées ;
- fusion inter-plans réglable ;
- pondération optionnelle du centre de l'image ;
- carte de profondeur et carte de confiance visibles dans l'interface.

La profondeur de v0.1 est **heuristique et relative** : elle utilise micro-structure,
contraste local et position dans l'image. Elle ne correspond ni à une distance en mètres,
ni à une reconstruction 3D, ni à une segmentation sémantique. Cette API est volontairement
préparée pour accueillir ultérieurement un modèle monoculaire ONNX sans changer le reste
du pipeline.

Pour préserver la mémoire et le temps de calcul sur mobile, la restauration Depth Focus
Precision est limitée à **8 MP en entrée**. Au-delà, l'étape est ignorée proprement et le
reste du pipeline continue.

## Scene Precision v0.2

Scene Precision ajoute un mode **Auto** et cinq presets manuels : Équilibré,
Texte & Enseignes, Objet principal, Agressif et Mobile Safe.

Le mode Auto analyse l'image localement à définition réduite et choisit un preset à partir
de quatre signaux : structures fines compatibles avec du texte, densité de contours,
proportion d'aplats et concentration de contours vers le centre. Cette analyse est
**heuristique** : elle ne fait ni OCR ni segmentation sémantique et ne prétend pas savoir
quel objet est réellement le sujet de la photo.

Le preset Objet principal active aussi une pondération centrale dans Precision Restore :
les contours structurés proches du centre peuvent recevoir une correction légèrement plus
forte, toujours limitée par les garde-fous anti-bruit et anti-halo.

## Quality Lab : vérifier le gain réel

Après chaque master image, UltraVision affiche désormais un comparateur **avant / après**
interactif et mesure le signal à résolution commune :

- gain de micro-détail par variance du Laplacien ;
- variation d'énergie des contours ;
- variation de contraste ;
- **SSIM par blocs** pour la similarité structurelle ;
- **PSNR** pour l'écart source/master ;
- pourcentage de pixels réellement modifiés ;
- carte de différence visualisant les zones où le master diverge de la source ;
- scores séparés texte probable / contours / aplats / structure centrale ;
- heatmaps dédiées pour visualiser les zones détectées par Scene Precision.

Ces métriques évitent de confondre un simple changement de conteneur ou de compression
avec une amélioration réelle. Elles ne certifient toutefois pas qu'un détail généré par
une IA correspond à la scène originale : une hausse de netteté doit toujours être
interprétée avec la comparaison visuelle.

## Cloud Pro GPT Image 2.5 — optionnel et mesuré

UltraVision conserve son pipeline local comme comportement par défaut. Un mode **Cloud Pro**
optionnel peut être configuré pour envoyer une copie réduite de la photo à un backend
sécurisé qui appelle **GPT Image 2.5 Sunburst**. Le résultat cloud ne remplace jamais
automatiquement le master local sur sa seule apparence : il est normalisé à la géométrie du
master puis repasse dans le duel local (SSIM, PSNR, détail, bruit et dérive chromatique).
S'il ne bat pas le master local avec les garde-fous actifs, il est rejeté.

L'application **ne demande jamais de clé OpenAI dans le navigateur**. Le backend
`api/cloud-pro.mjs` lit `OPENAI_API_KEY` uniquement côté serveur et exige un second secret
`CLOUD_PRO_ACCESS_TOKEN` pour éviter qu'un déploiement public puisse consommer librement
le quota API.

Variables serveur requises sur un hébergeur de Functions (par exemple Vercel) :

```text
OPENAI_API_KEY=...
CLOUD_PRO_ACCESS_TOKEN=un-secret-long-et-aleatoire
CLOUD_PRO_ALLOWED_ORIGINS=https://nikoju1977.github.io
# Optionnel :
OPENAI_IMAGE_MODEL=gpt-image-2.5-sunburst-2026-09-08
OPENAI_IMAGE_QUALITY=xhigh
```

Sur GitHub Pages seul, aucun runtime serveur n'existe : Cloud Pro reste donc non configuré
tant qu'un endpoint sécurisé n'est pas renseigné dans le panneau du résultat.

## Vie privée

- Aucune dépendance `@higgsfield/*`.
- Dépendances locales principales : `onnxruntime-web` (MIT), `mediabunny` (MPL-2.0).
- **Par défaut, images et vidéos restent sur l'appareil.**
- Les poids ONNX peuvent être téléchargés puis mis en cache localement.
- **Cloud Pro constitue l'unique exception explicite** : uniquement quand l'utilisateur
  ouvre ce panneau et lance volontairement l'envoi, une copie réduite de la photo est
  transmise à l'endpoint configuré puis à l'API d'image. Le master local reste le repli.
- La clé `OPENAI_API_KEY` ne doit jamais être exposée au navigateur, au dépôt GitHub ou
  aux logs.

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
- Depth Focus Precision v0.1 utilise une profondeur **relative heuristique**, pas une profondeur métrique.
  Son traitement pleine résolution est limité à **8 MP** pour protéger la mémoire locale.
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
navigateur** : disponibilité de l'URL du modèle, compatibilité de son graphe et temps de calcul effectif
sur ta machine.
