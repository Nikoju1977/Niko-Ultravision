import type { KeyboardEvent, ReactElement, ReactNode } from "react";
import { useMemo, useState } from "react";
import { User as IconCryptopunkOutlined } from "lucide-react";
import { DollarSign as IconDollarOutlined } from "lucide-react";
import { WandSparkles as IconImagineAiFilled } from "lucide-react";
import { BatteryFull as IconBatteryFullFilled } from "lucide-react";
import { Calendar as IconDateYearlyFilled } from "lucide-react";
import { House as IconHomeRoundDoorFilled } from "lucide-react";
import { Music as IconTiktokOutlined } from "lucide-react";
import { Video as IconVideoOutlined } from "lucide-react";
import { Button } from "@higgsfield/quanta/button";
import { Icon } from "@higgsfield/quanta/icon";
import { Media } from "@higgsfield/quanta/media";
import { Modal } from "@higgsfield/quanta/modal";
import { Tabs } from "@higgsfield/quanta/tabs";
import { Typography } from "@higgsfield/quanta/typography";

/**
 * TemplatePickerModal — the full-screen "template settings" picker that opens
 * from the Studio prompt box (Figma Marketing-Studio: the settings/Templates
 * control on node 7259:51362 opens this). A glass `Modal` (spirit of the
 * asset-library modal) whose body is a gallery of selectable IMAGE / VIDEO
 * template tiles, filtered by category (All / TikTok / UGC / Commercial) and by
 * media type (All / Image / Video).
 *
 * ── Figma note ────────────────────────────────────────────────────────────────
 * The referenced node (7259:51362) resolves to the Studio *prompt box* itself;
 * Figma exposes no standalone "template modal" node. The tile design is taken
 * verbatim from the Studio gallery cards (node 7137:108927 — brand header,
 * rounded triptych, gradient badge + title/subtitle + lime "Try"), and lifted
 * into a Quanta glass Modal following the asset-library composition. The exported
 * `TemplateCard` + `TEMPLATES` are exported so an in-page
 * gallery and the modal render identical tiles.
 */

// PLACEHOLDER ASSETS — template demo art (see /presets/*.png). When adapting
// this template into a real app, REPLACE media that represents the product
// (hero/example outputs, covers, before/after samples, feed items) with
// bespoke on-brand assets generated via the Higgsfield generation tools.
// Pure style-picker label thumbnails may keep simple placeholder art when
// real output depends on the user's own upload. Grep "PLACEHOLDER ASSETS"
// to find every site.
const THUMBS = [
  "/presets/chess-illustration.png",
  "/presets/skateboard-illustration.png",
  "/presets/chess-illustration.png",
  "/presets/skateboard-illustration.png",
] as const;

type LeadGlyph = typeof IconBatteryFullFilled;
export type TemplateCategory = "tiktok" | "ugc" | "commercial";
export type TemplateKind = "image" | "video";

export interface TemplateItem {
  id: string;
  title: string;
  subtitle: string;
  category: TemplateCategory;
  kind: TemplateKind;
  images: [string, string, string];
  icon: LeadGlyph;
}

// PLACEHOLDER ASSETS — demo data; replace when adapting (see note above).
export const TEMPLATES: TemplateItem[] = [
  {
    id: "ugc-gadget",
    title: "UGC Gadget save me",
    subtitle: "Turn long videos into short clips",
    category: "ugc",
    kind: "video",
    images: [THUMBS[0], THUMBS[1], THUMBS[2]],
    icon: IconBatteryFullFilled,
  },
  {
    id: "giant-figure",
    title: "Giant figure",
    subtitle: "Product hero, larger than life",
    category: "tiktok",
    kind: "image",
    images: [THUMBS[1], THUMBS[3], THUMBS[0]],
    icon: IconImagineAiFilled,
  },
  {
    id: "classic-modern",
    title: "Classic meets modern",
    subtitle: "Editorial style transfer",
    category: "commercial",
    kind: "image",
    images: [THUMBS[2], THUMBS[0], THUMBS[1]],
    icon: IconDateYearlyFilled,
  },
  {
    id: "couple-home",
    title: "Couple sharing home",
    subtitle: "Lifestyle story in 3 shots",
    category: "ugc",
    kind: "video",
    images: [THUMBS[3], THUMBS[2], THUMBS[0]],
    icon: IconHomeRoundDoorFilled,
  },
  {
    id: "unbox-hype",
    title: "Unboxing hype",
    subtitle: "Fast-cut reveal for TikTok",
    category: "tiktok",
    kind: "video",
    images: [THUMBS[0], THUMBS[2], THUMBS[3]],
    icon: IconImagineAiFilled,
  },
  {
    id: "studio-lookbook",
    title: "Studio lookbook",
    subtitle: "Clean commercial catalogue",
    category: "commercial",
    kind: "image",
    images: [THUMBS[1], THUMBS[0], THUMBS[3]],
    icon: IconDateYearlyFilled,
  },
];

/** Stable random-looking gradient per template — avoids SSR hydration differences. */
function gradientFromSeed(seed: string): string {
  let hash = 0;
  for (const character of seed) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  const startHue = hash % 360;
  const endHue = (startHue + 36 + ((hash >>> 8) % 72)) % 360;
  return `linear-gradient(135deg, hsl(${startHue} 62% 52%) 0%, hsl(${endHue} 76% 27%) 100%)`;
}

/** Figma 22375:39892 gradient icon tile with a deterministic random palette. */
function GradientBadge({ as, seed }: { as: LeadGlyph; seed: string }) {
  return (
    <span className="relative flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-[10px] border-[1.333px] border-[rgba(197,197,197,0.24)] p-1.5 text-white shadow-[0_5.333px_2.667px_rgba(0,0,0,0.08),inset_0_2.667px_5.333px_rgba(255,255,255,0.24)]">
      <span
        aria-hidden
        className="absolute inset-0 rounded-[10px]"
        style={{ backgroundImage: gradientFromSeed(seed) }}
      />
      <span
        aria-hidden
        className="absolute inset-0 rounded-[10px] bg-gradient-to-t from-transparent to-white/20 mix-blend-overlay"
      />
      <span
        aria-hidden
        className="absolute inset-0 rounded-[10px] bg-gradient-to-t from-transparent to-white/[0.32] mix-blend-hard-light"
      />
      <Icon as={as} size="md" className="relative" />
    </span>
  );
}

const TRIPTYCH_CORNERS = [
  "rounded-tl-q-500 rounded-bl-q-500 rounded-tr-q-150 rounded-br-q-150",
  "rounded-q-150",
  "rounded-tr-q-500 rounded-br-q-500 rounded-tl-q-150 rounded-bl-q-150",
] as const;

/**
 * Preview layout of a template tile:
 *   • `single`   — ONE full-width shot (the base tile). Default.
 *   • `triptych` — the 3-shot rounded triptych variation.
 */
export type TemplateCardVariant = "single" | "triptych";

export interface TemplateCardProps {
  template: TemplateItem;
  /** Preview layout. `single` (one full-width image) is the base; `triptych` is the 3-shot variation. */
  variant?: TemplateCardVariant;
  /** Fired by the "Try" action (wire to seed the prompt box / start a generation). */
  onTry: (template: TemplateItem) => void;
  /** Swap the "Try" label (e.g. "Use"). */
  tryLabel?: ReactNode;
}

/**
 * A single marketing template tile — Figma Marketing-Studio gallery card
 * (7137:108927): co-brand header, a rounded preview (base = one full-width shot;
 * the `triptych` variant shows 3 shots), and a footer with a gradient category
 * badge, the title/subtitle, and the lime "Try" CTA.
 */
export function TemplateCard({
  template,
  variant = "single",
  onTry,
  tryLabel = "Try",
}: TemplateCardProps) {
  const handleCardKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.currentTarget !== event.target) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onTry(template);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Use template: ${template.title}`}
      className="motion-card relative flex cursor-pointer flex-col gap-q-200 rounded-q-600 bg-q-transparent-light-05 p-q-200 shadow-[0_2px_6px_rgba(0,0,0,0.15)] hover:z-[1] focus-visible:outline-2 focus-visible:outline-q-border-focus"
      onClick={() => onTry(template)}
      onKeyDown={handleCardKeyDown}
    >
      <div className="flex h-60 items-stretch gap-1.5">
        {variant === "triptych" ? (
          template.images.map((src, index) => (
            <Media
              key={index}
              ratio="auto"
              rounded="none"
              className={`min-w-0 flex-1 border border-q-border-subtle ${TRIPTYCH_CORNERS[index]}`}
            >
              <Media.Image src={src} alt={`${template.title} — shot ${index + 1}`} />
            </Media>
          ))
        ) : (
          <Media
            ratio="auto"
            rounded="none"
            className="min-w-0 flex-1 rounded-q-500 border border-q-border-subtle"
          >
            <Media.Image src={template.images[0]} alt={template.title} />
          </Media>
        )}
      </div>
      <div className="flex items-center gap-3 px-2 py-1">
        <GradientBadge as={template.icon} seed={template.id} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Typography as="span" variant="label-md-medium" color="primary" truncate>
            {template.title}
          </Typography>
          <Typography as="span" variant="caption-sm-regular" color="secondary" truncate>
            {template.subtitle}
          </Typography>
        </div>
        <Button
          variant="marketingPrimary"
          size="sm"
          onClick={(event) => {
            event.stopPropagation();
            onTry(template);
          }}
        >
          {tryLabel}
        </Button>
      </div>
    </div>
  );
}

/* ── Filter tabs ──────────────────────────────────────────────────────────── */

const CATEGORY_TABS = [
  { value: "all", label: "All" },
  { value: "tiktok", label: "TikTok", start: <Icon size="sm" as={IconTiktokOutlined} /> },
  { value: "ugc", label: "UGC", start: <Icon size="sm" as={IconCryptopunkOutlined} /> },
  { value: "commercial", label: "Commercial", start: <Icon size="sm" as={IconDollarOutlined} /> },
];

const TYPE_TABS = [
  { value: "all", label: "All" },
  { value: "image", label: "Image", start: <Icon size="sm" as={IconImagineAiFilled} /> },
  { value: "video", label: "Video", start: <Icon size="sm" as={IconVideoOutlined} /> },
];

export interface TemplatePickerModalProps {
  /** The trigger element (e.g. a PromptBox.Pill). Rendered as the Modal trigger. */
  trigger: ReactElement;
  /** Fired when a template's "Try" is clicked (wire to seed the prompt box). */
  onSelect: (template: TemplateItem) => void;
  /** Start opened (uncontrolled) — handy for previews. */
  defaultOpen?: boolean;
}

export function TemplatePickerModal({ trigger, onSelect, defaultOpen }: TemplatePickerModalProps) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const [category, setCategory] = useState("all");
  const [kind, setKind] = useState("all");

  const visible = useMemo(
    () =>
      TEMPLATES.filter(
        (t) =>
          (category === "all" || t.category === category) && (kind === "all" || t.kind === kind),
      ),
    [category, kind],
  );

  return (
    <Modal.Root open={open} onOpenChange={setOpen}>
      <Modal.Trigger render={trigger} />
      <Modal.Content size="2xl">
        <Modal.Header flush className="px-2 py-1">
          <Tabs.Root variant="pill" value={category} onValueChange={setCategory} className="flex-1">
            <Tabs.List items={CATEGORY_TABS} />
          </Tabs.Root>
          <Modal.CloseButton />
        </Modal.Header>

        <div className="flex items-center gap-4 px-1 pb-3">
          <Tabs.Root variant="segmented" value={kind} onValueChange={setKind}>
            <Tabs.List items={TYPE_TABS} />
          </Tabs.Root>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid grid-cols-2 gap-5 p-1">
            {visible.map((template) => (
              <TemplateCard
                key={template.id}
                template={template}
                onTry={(selected) => {
                  onSelect(selected);
                  setOpen(false);
                }}
                tryLabel="Use"
              />
            ))}
          </div>
        </div>

        <Modal.Footer>
          <Modal.FooterCaption>
            {visible.length} template
            {visible.length === 1 ? "" : "s"}
          </Modal.FooterCaption>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
