"use client";

import type { ComponentPropsWithRef } from "react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { icon } from "@higgsfield/quanta/icon";
import { cn as cx } from "@/lib/utils";

/**
 * IconTile — a 24px leading tile with a glyph centered inside a box, for
 * navigation / list rows (Figma SC App Builder "Share Modal" leading tile
 * "Left_lg" 2125:15286, and the neutral "New folder" tile 2125:15346). Two
 * looks share the same footprint (`space/600`, `radius/200`):
 *
 *   <IconTile as={AtIcon} gradient="blue" />          // colored brand tile
 *   <IconTile as={FolderIcon} />                      // neutral white-5% tile
 *
 * The `gradient` look is a colored box (hairline light border + drop/inset
 * sheen + two blended white sheens) with a WHITE glyph; omit `gradient` for the
 * neutral raised box with a `secondary` glyph. The gradient STOPS + sheens are
 * the one necessary literal — these branded fills have no Quanta token; the
 * size / radius / neutral surface all come from tokens. Gradient tiles use the
 * Phosphor glyph's real `weight="fill"` artwork so the small icon remains
 * legible on the color.
 *
 * Pass a brand preset (`'blue'` | `'teal'` | `'purple'` | `'pink'` | `'orange'`
 * | `'green'` | `'red'` | `'indigo'`) or any CSS gradient string. The tile is a
 * passive `<span>`; spread `aria-*` / `className` as needed — the glyph is
 * decorative, so the row label carries the meaning.
 */

export type IconTileGradient =
  "blue" | "teal" | "purple" | "pink" | "orange" | "green" | "red" | "indigo";

/**
 * Brand gradient presets for the colored tile. The stops are bespoke branded
 * fills (no Quanta gradient token exists), kept here so every surface that uses
 * a colored icon tile shares the exact same fills. All follow the same 135°
 * light-to-deep sweep so a row of mixed tiles reads as one family.
 */
export const ICON_TILE_GRADIENT: Record<IconTileGradient, string> = {
  blue: "linear-gradient(135deg, rgb(65, 136, 190) 0%, rgb(14, 39, 114) 100%)",
  teal: "linear-gradient(135deg, rgb(81, 226, 224) 3.8675%, rgb(18, 92, 141) 93.451%)",
  purple: "linear-gradient(135deg, rgb(158, 120, 226) 0%, rgb(63, 26, 130) 100%)",
  pink: "linear-gradient(135deg, rgb(226, 110, 178) 0%, rgb(130, 20, 74) 100%)",
  orange: "linear-gradient(135deg, rgb(245, 168, 88) 0%, rgb(168, 66, 18) 100%)",
  green: "linear-gradient(135deg, rgb(104, 205, 128) 0%, rgb(20, 96, 58) 100%)",
  red: "linear-gradient(135deg, rgb(235, 108, 104) 0%, rgb(140, 22, 34) 100%)",
  indigo: "linear-gradient(135deg, rgb(110, 128, 226) 0%, rgb(30, 34, 130) 100%)",
};

export type IconTileProps = ComponentPropsWithRef<"span"> & {
  /** Glyph painted at 16px (white on gradient, `secondary` on neutral). */
  as: PhosphorIcon;
  /**
   * Colored gradient backing — a brand preset (`'blue'` / `'teal'` / `'purple'`
   * / `'pink'` / `'orange'` / `'green'` / `'red'` / `'indigo'`) or any CSS
   * gradient string. Omit for the neutral (white-5% raised) tile.
   */
  gradient?: IconTileGradient | (string & {});
};

export function IconTile({ as, gradient, className, style, ...props }: IconTileProps) {
  const Glyph = as;
  const isGradient = gradient != null;
  const backgroundImage = isGradient
    ? (ICON_TILE_GRADIENT[gradient as IconTileGradient] ?? gradient)
    : undefined;

  return (
    <span
      className={cx(
        "q-icon-tile",
        isGradient ? "q-icon-tile-gradient" : "q-icon-tile-neutral",
        className,
      )}
      style={isGradient ? { backgroundImage, ...style } : style}
      {...props}
    >
      <Glyph
        weight={isGradient ? "fill" : "regular"}
        aria-hidden
        className={cx(
          icon({ size: "sm", color: isGradient ? undefined : "secondary" }),
          "q-icon-tile-glyph",
        )}
      />
    </span>
  );
}
