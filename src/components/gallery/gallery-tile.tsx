import { memo, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Download as IconDownload } from "lucide-react";
import { Copy as IconContentCopy } from "lucide-react";
import { Share2 as IconShare } from "lucide-react";
import { GenerationTile } from "@/components/generation-card";
import type { CardAction } from "@/components/generation-card";
import type { TileRect } from "./justified-engine.ts";
import type { GalleryItem, LoadTier } from "./types.ts";

/**
 * One gallery tile. It is absolutely positioned at the engine-computed rect and
 * composed from Quanta primitives:
 *   • `generating` items → `GenerationCard state="generating"` (the pulsing card).
 *   • ready items → a `GenerationCard` (image or hover-to-play video) that is the
 *     trigger of a `GenerationDetailModal`, preserving the click-to-open behavior.
 *
 * Load tiers are driven by the engine layer. Mounted media stays mounted while
 * scrolling so completed generations never flash back to placeholders.
 */

export interface GalleryTileProps {
  item: GalleryItem;
  rect: TileRect;
  /** Row top, in content coordinates (the rect's x is row-relative). */
  top: number;
  tier: LoadTier;
  reducedMotion: boolean;
}

function rectStyle(rect: TileRect, top: number): CSSProperties {
  return {
    left: rect.x,
    top,
    width: rect.width,
    height: rect.height,
  } as CSSProperties;
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText != null) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

async function shareItem(item: GalleryItem): Promise<void> {
  const url = new URL(item.videoSrc ?? item.src, window.location.href).href;
  if (navigator.share != null) {
    await navigator.share({
      title: "Generated media",
      text: item.prompt,
      url,
    });
    return;
  }

  await copyText(`${item.prompt}\n${url}`);
}

/** Neutral Quanta surface shown only until the media itself is ready. */
function Placeholder() {
  return <span className="qg-placeholder" aria-hidden="true" />;
}

/** Still image with native tier-driven loading and no remount fade. */
function StillMedia({ item, tier }: { item: GalleryItem; tier: LoadTier }) {
  return (
    <>
      <Placeholder />
      <img
        className="absolute inset-0 size-full object-cover"
        src={item.src}
        alt={item.alt}
        loading={tier === "full" ? "eager" : "lazy"}
        decoding="async"
      />
    </>
  );
}

/**
 * Hover-to-play video: poster still by default, plays (muted / looped /
 * playsInline) on hover & focus, pauses and resets on leave. Respects reduced
 * motion — when set, the poster stays put and the clip never autoplays on hover.
 */
function HoverVideo({
  item,
  tier,
  playing,
  reducedMotion,
}: {
  item: GalleryItem;
  tier: LoadTier;
  playing: boolean;
  reducedMotion: boolean;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [videoLoaded, setVideoLoaded] = useState(false);
  const active = playing && !reducedMotion;
  const hasPoster = item.src.length > 0;
  const showVideo = active && videoLoaded;

  useEffect(() => {
    const v = ref.current;
    if (v == null) return;
    if (active) {
      void v.play()?.catch(() => {});
    } else {
      v.pause();
      try {
        v.currentTime = 0;
      } catch {}
    }
  }, [active]);

  return (
    <>
      <Placeholder />
      {hasPoster ? (
        <img
          className="absolute inset-0 size-full object-cover"
          src={item.src}
          alt={item.alt}
          loading={tier === "full" ? "eager" : "lazy"}
          decoding="async"
          style={{ opacity: showVideo ? 0 : 1 }}
        />
      ) : null}
      {/* Historical video nodes stay network-idle until explicit hover/focus. */}
      <video
        ref={ref}
        className="absolute inset-0 size-full object-cover"
        muted
        loop
        playsInline
        preload="none"
        poster={hasPoster ? item.src : undefined}
        onLoadedData={() => setVideoLoaded(true)}
        style={{ opacity: showVideo ? 1 : 0 }}
      >
        <source src={item.videoSrc} />
      </video>
    </>
  );
}

function GalleryTileComponent({ item, rect, top, tier, reducedMotion }: GalleryTileProps) {
  const [hovered, setHovered] = useState(false);

  if (item.status === "generating") {
    return (
      <GenerationTile
        state="generating"
        ratio="auto"
        className="qg-tile"
        style={rectStyle(rect, top)}
      />
    );
  }

  if (item.status === "failed") {
    return (
      <GenerationTile
        state="failed"
        ratio="auto"
        failureLabel={item.failureLabel}
        className="qg-tile"
        style={rectStyle(rect, top)}
      />
    );
  }

  const isVideo = item.kind === "video";
  const media = isVideo ? (
    <HoverVideo item={item} tier={tier} playing={hovered} reducedMotion={reducedMotion} />
  ) : (
    <StillMedia item={item} tier={tier} />
  );

  // Per-tile affordances. `CardActions` caps the visible controls at 3 (its
  // default `max`): with more than that, the first two render as glass buttons
  // and the rest collapse into the three-dots overflow menu.
  const actions: CardAction[] = [
    { id: "download", label: "Download", icon: IconDownload },
    {
      id: "copy",
      label: "Copy prompt",
      icon: IconContentCopy,
      onSelect: () => {
        void copyText(item.prompt).catch((error) => {
          console.error("Failed to copy generation prompt", error);
        });
      },
    },
    {
      id: "share",
      label: "Share",
      icon: IconShare,
      onSelect: () => {
        void shareItem(item).catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          console.error("Failed to share generation", error);
        });
      },
    },
  ];

  // The canonical single-generation tile: it owns the full-bleed open trigger and
  // the hover `CardActions` rail (siblings, never nested), so this feed reads the
  // SAME as every other generation card in the app. The feed only supplies the
  // engine-positioned frame + its media (hover-to-play video / tiered still).
  return (
    <GenerationTile
      ratio="auto"
      className="qg-tile"
      style={rectStyle(rect, top)}
      media={media}
      actions={actions}
      generation={{
        src: isVideo ? (item.videoSrc ?? item.src) : item.src,
        poster: isVideo ? item.src : undefined,
        mediaType: isVideo ? "video" : "image",
        aspectRatio: item.width / item.height,
        prompt: item.prompt,
        ...(item.author != null ? { author: item.author } : {}),
      }}
      openLabel={`Open generation: ${item.prompt}`}
      onMouseEnter={isVideo ? () => setHovered(true) : undefined}
      onMouseLeave={isVideo ? () => setHovered(false) : undefined}
      onFocus={isVideo ? () => setHovered(true) : undefined}
      onBlur={isVideo ? () => setHovered(false) : undefined}
    />
  );
}

export const GalleryTile = memo(GalleryTileComponent);
