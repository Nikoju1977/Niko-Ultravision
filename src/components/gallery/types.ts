/**
 * Data model for the justified-masonry History gallery.
 *
 * A `GalleryItem` is a single generation. Its width/height pair represents
 * either intrinsic pixels or an equivalent aspect-ratio pair; only their ratio
 * drives the justified layout.
 */

export type MediaKind = "image" | "video";
export type ItemStatus = "ready" | "generating" | "failed";

export interface GalleryItem {
  /** Stable id — used as the React key. */
  id: string;
  /** Owning Studio project when the generation was created from a project view. */
  projectId?: string;
  /** Creation timestamp used to select the latest project thumbnail. */
  createdAt?: string | number;
  /** `image` renders an `<img>`, `video` renders a hover-to-play `<video>` + poster. */
  kind: MediaKind;
  /** Lifecycle — `ready` shows the asset, `generating` shows the pulsing card. */
  status: ItemStatus;
  /** The still source: the image for `image`, the poster frame for `video`. */
  src: string;
  /** Video source (only meaningful when `kind === 'video'`). */
  videoSrc?: string;
  /** Width or ratio numerator used by the layout. */
  width: number;
  /** Height or ratio denominator used by the layout. */
  height: number;
  /** Human-readable terminal failure/unavailable reason. */
  failureLabel?: string;
  /** The generation prompt (shown in the detail modal + used as the a11y label). */
  prompt: string;
  /** Accessible alt text for the still. */
  alt: string;
  /** Real generation owner shown in the detail viewer. */
  author?: { name: string; role?: string; avatarSrc?: string };
  /** Which dated batch this item belongs to (e.g. `today`). */
  groupId: string;
  /** Human batch label rendered as the section header (e.g. `Today`). */
  groupLabel: string;
}

/** How near a tile is to the viewport — drives the load tier (quality upgrade). */
export type LoadTier = "full" | "near" | "far";
