"use client";

import type { ComponentProps, ReactElement, ReactNode, Ref } from "react";
import { useRender } from "@base-ui/react/use-render";
import { Loader } from "@higgsfield/quanta/loader";
import { Media } from "@higgsfield/quanta/media";
import { Typography } from "@higgsfield/quanta/typography";
import { cn as cx } from "@/lib/utils";

/**
 * GenerationCard — a single generation result tile for feed / history grids
 * (Figma Supercomputer-2 "Feed/Card" 2001:84301 + Cinema-Studio-V4 generating
 * state 20037:25838). It composes `Media` (a fixed-ratio, square-cornered
 * box) into the three states a generation moves through:
 *
 *   • `ready` (default) — the finished asset: a cover `Media.Image` (or any
 *     custom `media` node — e.g. a `Media.Video`), with an optional bottom
 *     `title` over the media scrim.
 *   • `generating` — the in-progress placeholder: a dark canvas with a brand
 *     gradient glow pulsing at the TOP of the card and a "Generating" status
 *     pill (spinner + brand label). The pulse is a CSS animation that honors
 *     `prefers-reduced-motion`.
 *   • `failed` — a stable neutral error tile, so terminal jobs never vanish
 *     from history after their generating placeholder was visible.
 *
 *   <GenerationCard src={cover} alt="Pool float" />
 *   <GenerationCard state="generating" ratio="portrait" />
 *
 * Tokens only, composition-first: `media` swaps the default image, `children`
 * compose extra overlays inside the frame, and the host element is swappable via
 * `render` (Base UI `useRender`) for clickable tiles.
 */

export type GenerationCardState = "ready" | "generating" | "failed";

export type GenerationCardProps = Omit<ComponentProps<"div">, "title"> & {
  /** Lifecycle state — ready asset, generating placeholder, or terminal failure. */
  state?: GenerationCardState;
  /** Image source for the default `Media.Image` (ready state). Ignored when `media` is set. */
  src?: string;
  /** Alt text for the default image. */
  alt?: string;
  /** Aspect ratio, forwarded to `Media` (default `video`). */
  ratio?: ComponentProps<typeof Media>["ratio"];
  /** Custom media node (a `Media.Video`, a fallback…) instead of the default image. */
  media?: ReactNode;
  /** Optional bottom title, over the media scrim. Ready state only. */
  title?: ReactNode;
  /** Status pill label shown while generating. Default `Generating`. */
  generatingLabel?: ReactNode;
  /** Message shown for a terminal failed/unavailable generation. */
  failureLabel?: ReactNode;
  /** Extra overlay content composed inside the frame. */
  children?: ReactNode;
  /** Swap the host element — `<button>`/`<a>`/`<Link>` for clickable tiles. */
  render?: ReactElement;
  ref?: Ref<Element>;
};

/** The pulsing top glow + "Generating" status pill (Cinema-Studio-V4 20037:25838). */
function GeneratingOverlay({ label }: { label: ReactNode }) {
  return (
    <span className="q-generation-card-generating">
      <span className="q-generation-card-glow" aria-hidden="true" />
      <span className="q-generation-card-status">
        {/* Loader owns role="status" + aria-label; the label text is its visible echo. */}
        <Loader
          variant="circle"
          size="xs"
          color="brand"
          aria-label={typeof label === "string" ? label : "Generating"}
        />
        <Typography as="span" variant="body-sm-medium" color="brand" aria-hidden="true">
          {label}
        </Typography>
      </span>
    </span>
  );
}

function FailureOverlay({ label }: { label: ReactNode }) {
  return (
    <span className="q-generation-card-failed" role="status">
      <Typography as="span" variant="body-sm-semi-bold" color="primary">
        Generation unavailable
      </Typography>
      <Typography as="span" variant="caption-sm-regular" color="secondary">
        {label}
      </Typography>
    </span>
  );
}

function GenerationCard({
  state = "ready",
  src,
  alt = "",
  ratio = "video",
  media,
  title,
  generatingLabel = "Generating",
  failureLabel = "The generation did not produce previewable media.",
  className,
  children,
  render,
  ref,
  ...props
}: GenerationCardProps) {
  const generating = state === "generating";
  const failed = state === "failed";

  const content = (
    <>
      <Media ratio={ratio} rounded="none" className="q-generation-card-media">
        {generating || failed
          ? (media ?? <Media.Fallback className="q-generation-card-canvas" />)
          : (media ?? (src != null ? <Media.Image src={src} alt={alt} /> : <Media.Fallback />))}
      </Media>
      {!generating && title != null ? (
        <Media.Overlay placement="bottom" className="q-generation-card-caption">
          <Typography
            as="span"
            variant="body-sm-semi-bold"
            color="primary"
            className="q-generation-card-title"
          >
            {title}
          </Typography>
        </Media.Overlay>
      ) : null}
      {generating ? <GeneratingOverlay label={generatingLabel} /> : null}
      {failed ? <FailureOverlay label={failureLabel} /> : null}
      {children}
    </>
  );

  return useRender({
    render,
    defaultTagName: "div",
    ref: ref as Ref<Element> | undefined,
    props: {
      className: cx("q-generation-card", className),
      "data-state": state,
      children: content,
      ...props,
    },
  });
}

export { GenerationCard };
