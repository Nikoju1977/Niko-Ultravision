export type ProfileId = "fidelity" | "archive" | "cinema" | "detail";

export const PROFILES: Record<ProfileId, { label: string; description: string; filter: string; sharpen: number }> = {
  fidelity: {
    label: "Fidelity Pro",
    description: "Ratio, cadrage et couleurs aussi neutres que possible.",
    filter: "contrast(1.01)",
    sharpen: 0.18,
  },
  archive: {
    label: "Archive",
    description: "Réduction visuelle douce des défauts et contraste contenu.",
    filter: "contrast(1.01) saturate(0.98)",
    sharpen: 0.10,
  },
  cinema: {
    label: "Cinema Restore",
    description: "Contraste légèrement renforcé sans recadrage.",
    filter: "contrast(1.03) saturate(1.01)",
    sharpen: 0.20,
  },
  detail: {
    label: "Ultra Detail",
    description: "Accentuation locale renforcée et finition de netteté après upscale.",
    filter: "contrast(1.045) saturate(1.02)",
    sharpen: 0.36,
  },
};
