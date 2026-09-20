export type ProfileId = "fidelity" | "archive" | "cinema" | "detail";

export const PROFILES: Record<ProfileId, { label: string; description: string; filter: string; sharpen: number }> = {
  fidelity: {
    label: "Fidelity Pro",
    description: "Ratio, cadrage et couleurs aussi neutres que possible.",
    filter: "none",
    sharpen: 0.12,
  },
  archive: {
    label: "Archive",
    description: "Réduction visuelle douce des défauts et contraste contenu.",
    filter: "contrast(1.02) saturate(0.98)",
    sharpen: 0.08,
  },
  cinema: {
    label: "Cinema Restore",
    description: "Contraste légèrement renforcé sans recadrage.",
    filter: "contrast(1.04) saturate(1.02)",
    sharpen: 0.14,
  },
  detail: {
    label: "Ultra Detail",
    description: "Accentuation locale plus marquée pour les petites sources.",
    filter: "contrast(1.05) saturate(1.03)",
    sharpen: 0.24,
  },
};
