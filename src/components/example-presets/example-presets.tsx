"use client";

import type { ReactNode } from "react";
import { Tabs } from "@higgsfield/quanta/tabs";
import { TemplateCard } from "@/components/template-picker";
import type { TemplateItem } from "@/components/template-picker";
import { cn as cx } from "@/lib/utils";

/**
 * ExamplePresets — the "what you can make" showcase: a filter-tab row over a
 * Responsive grid of `TemplateCard` examples. Each card's CTA reports the
 * picked preset via `onUse`, so a screen can seed its prompt box with that
 * example's settings (title/subtitle → prompt, category → format, …).
 *
 * The grid content and tabs are CONTENT you pass in; the layout stays
 * centralized here so every "examples" section reads the same.
 */
export interface ExamplePresetTab {
  value: string;
  label: ReactNode;
  start?: ReactNode;
}

export interface ExamplePresetsProps {
  /** The example presets to show as cards. */
  items: TemplateItem[];
  /** Category tabs above the grid. */
  tabs?: ExamplePresetTab[];
  /** Fired when a card's CTA is clicked — seed the prompt box with this preset. */
  onUse: (preset: TemplateItem) => void;
  /** CTA label on each card. Default `Try`. */
  tryLabel?: ReactNode;
  className?: string;
}

export function ExamplePresets({
  items,
  tabs,
  onUse,
  tryLabel = "Try",
  className = "w-full max-w-[900px]",
}: ExamplePresetsProps) {
  return (
    <div className={cx("flex flex-col items-center gap-5", className)}>
      {tabs != null && tabs.length > 0 ? (
        <Tabs.Root
          className="example-presets-tabs"
          variant="segmented"
          shape="pill"
          surface="glass"
          tone="glass"
          defaultValue={tabs[0]?.value}
        >
          <Tabs.List items={tabs} />
        </Tabs.Root>
      ) : null}
      <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-5">
        {items.map((preset) => (
          <TemplateCard key={preset.id} template={preset} onTry={onUse} tryLabel={tryLabel} />
        ))}
      </div>
    </div>
  );
}
