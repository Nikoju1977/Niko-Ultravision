/**
 * Registre des modèles open source de restauration photo exécutés localement.
 *
 * Chaque entrée pointe vers un fichier ONNX unique (pas de poids externes),
 * épinglé sur une révision quand c'est possible pour éviter qu'une mise à jour
 * amont casse l'app. Le moteur lit lui-même la forme d'entrée (fixe ou
 * dynamique), le type (FP32/FP16) et le facteur réel : les valeurs ci-dessous
 * ne servent qu'au routage et à l'affichage.
 */

export type RestorationModelId =
  | "realesrgan-general-x4v3"
  | "realesrgan-x4plus"
  | "swin2sr-classical-x4"
  | "swin2sr-realworld-x4"
  | "swin2sr-compressed-x4"
  | "swin2sr-lightweight-x2";

export interface RestorationModel {
  id: RestorationModelId;
  label: string;
  family: "Real-ESRGAN" | "Swin2SR";
  url: string;
  nominalScale: number;
  sizeMb: number;
  /** Ce pour quoi le modèle a été entraîné. */
  specialty: string;
  license: string;
  /** Trop lourd pour être essayé par défaut sur un appareil modeste. */
  heavy: boolean;
}

export const RESTORATION_MODELS: Record<RestorationModelId, RestorationModel> = {
  "realesrgan-general-x4v3": {
    id: "realesrgan-general-x4v3",
    label: "Real-ESRGAN General x4v3",
    family: "Real-ESRGAN",
    url: "https://huggingface.co/qualcomm/Real-ESRGAN-General-x4v3/resolve/02ed12055c77a6aee15bd6636f62bd8b092addcd/Real-ESRGAN-General-x4v3.onnx",
    nominalScale: 4,
    sizeMb: 4.9,
    specialty: "photos réelles, rapide, textures nettes",
    license: "BSD-3-Clause",
    heavy: false,
  },
  "realesrgan-x4plus": {
    id: "realesrgan-x4plus",
    label: "Real-ESRGAN x4plus",
    family: "Real-ESRGAN",
    url: "https://huggingface.co/qualcomm/Real-ESRGAN-x4plus/resolve/92d7a0c6b345146022a10bfdf7a1c69eca313b76/Real-ESRGAN-x4plus.onnx",
    nominalScale: 4,
    sizeMb: 67.1,
    specialty: "dégradations réelles fortes (flou, bruit, compression)",
    license: "BSD-3-Clause",
    heavy: true,
  },
  "swin2sr-classical-x4": {
    id: "swin2sr-classical-x4",
    label: "Swin2SR Classical x4",
    family: "Swin2SR",
    url: "https://huggingface.co/Xenova/swin2SR-classical-sr-x4-64/resolve/main/onnx/model.onnx",
    nominalScale: 4,
    sizeMb: 55,
    specialty: "images propres, fidélité maximale",
    license: "Apache-2.0",
    heavy: true,
  },
  "swin2sr-realworld-x4": {
    id: "swin2sr-realworld-x4",
    label: "Swin2SR Real-World x4",
    family: "Swin2SR",
    url: "https://huggingface.co/Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr/resolve/main/onnx/model.onnx",
    nominalScale: 4,
    sizeMb: 55,
    specialty: "bruit et flou réels (dégradations BSRGAN)",
    license: "Apache-2.0",
    heavy: true,
  },
  "swin2sr-compressed-x4": {
    id: "swin2sr-compressed-x4",
    label: "Swin2SR Compressed x4",
    family: "Swin2SR",
    url: "https://huggingface.co/Xenova/swin2SR-compressed-sr-x4-48/resolve/main/onnx/model.onnx",
    nominalScale: 4,
    sizeMb: 55,
    specialty: "JPEG fortement compressé (blocs, ringing)",
    license: "Apache-2.0",
    heavy: true,
  },
  "swin2sr-lightweight-x2": {
    id: "swin2sr-lightweight-x2",
    label: "Swin2SR Lightweight x2",
    family: "Swin2SR",
    url: "https://huggingface.co/Xenova/swin2SR-lightweight-x2-64/resolve/main/onnx/model.onnx",
    nominalScale: 2,
    sizeMb: 4,
    specialty: "agrandissement x2 léger, mobile",
    license: "Apache-2.0",
    heavy: false,
  },
};
