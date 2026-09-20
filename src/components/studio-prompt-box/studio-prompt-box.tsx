"use client";

import type {
  ChangeEvent,
  ComponentProps,
  ComponentType,
  MouseEventHandler,
  ReactElement,
  ReactNode,
} from "react";
import { cloneElement, useState } from "react";
import { ChevronDown as IconChevronDownSmallOutlined } from "lucide-react";
import { Plus as IconPlusMediumOutlined } from "lucide-react";
import { SlidersHorizontal as IconSettingsSliderHorOutlined } from "lucide-react";
import { X as IconCrossSmallOutlined } from "lucide-react";
import { Icon } from "@higgsfield/quanta/icon";
import type { IconGlyph } from "@higgsfield/quanta/icon";
import { Select } from "@higgsfield/quanta/select";
import type {
  AssetLibraryItem,
  AssetLibraryModalProps,
  AssetLibraryPagination,
  AssetSelection,
} from "@/components/asset-library";
import { TemplatePickerModal } from "@/components/template-picker";
import type { TemplateItem } from "@/components/template-picker";
import { PromptBox } from "@/components/prompt-box";

/**
 * StudioPromptBox — THE canonical Studio prompt dock. A configured, prop-driven
 * composition of the `PromptBox` parts that LOCKS IN the Studio settings
 * contract so every screen's prompt dock reads the same:
 *
 *   1. MODE RAIL (`modes`) — the vertical Product/App-style switch. Rendered
 *      ONLY when there are ≥2 modes (you switch modes only when they genuinely
 *      differ); a single/absent mode hides the rail.
 *   2. INLINE SETTING PILLS (`settings`) — the base, always-visible dropdowns in
 *      the footer. Hard-capped at `MAX_INLINE_SETTINGS` (2); passing more is a
 *      contract error. Build a real advanced-settings surface first if the
 *      adapted product needs more.
 *   3. UPLOAD TILES (`uploads`) — the big square reference tiles for the few
 *      VERY important inputs (Product / Avatar …). Hard-capped at `MAX_UPLOADS`
 *      (2).
 *
 * The "+" add-media pill is mandatory and always opens the asset library. The
 * sliders pill opens the template picker; the CTA is the lime Generate
 * button. Callers only supply the CONTENT via config — the layout and the caps
 * are fixed here.
 */

/** Hard cap for this dock; add a real advanced surface before exceeding it. */
export const MAX_INLINE_SETTINGS = 2;
/** Hard cap: at most this many reference/upload tiles ("very important settings"). */
export const MAX_UPLOADS = 2;

/** A generation mode in the vertical rail (e.g. Product / App). */
export interface PromptModeOption {
  id: string;
  label: ReactNode;
  icon: IconGlyph;
}

/** An inline setting pill that opens a compact dropdown picker. */
export interface PromptSettingOption {
  id: string;
  /** Leading glyph shown in the pill. */
  start?: ReactNode;
  /** Initially selected option value. */
  defaultValue: string;
  /** The pickable options. */
  options: { value: string; title: string; subtitle?: string }[];
}

/** A reference-image upload tile (a "very important" input). */
export interface PromptUploadOption {
  id: string;
  label?: ReactNode;
  /** Durable selected reference; omit for the empty "+" tile. */
  selection?: AssetSelection;
}

export interface StudioAssetLibrary {
  items: AssetLibraryItem[];
  onUpload: (file: File) => Promise<AssetSelection>;
  pagination: AssetLibraryPagination;
}

type AssetLibraryModalComponent = ComponentType<AssetLibraryModalProps>;
type DeferredTriggerProps = {
  onClick?: MouseEventHandler<HTMLElement>;
  "aria-busy"?: boolean;
  "aria-haspopup"?: "dialog";
};

/** Keep the modal's virtual grid and media controls out of the initial route. */
function DeferredAssetLibraryModal(props: AssetLibraryModalProps) {
  const [ModalComponent, setModalComponent] = useState<AssetLibraryModalComponent | null>(null);
  const [loading, setLoading] = useState(false);
  const trigger = props.trigger as ReactElement<DeferredTriggerProps>;

  if (ModalComponent != null) {
    return <ModalComponent {...props} defaultOpen />;
  }

  return cloneElement(trigger, {
    "aria-busy": loading || undefined,
    "aria-haspopup": "dialog",
    onClick: (event) => {
      trigger.props.onClick?.(event);
      if (event.defaultPrevented || loading) return;

      setLoading(true);
      void import("@/components/asset-library")
        .then(({ AssetLibraryModal }) => setModalComponent(() => AssetLibraryModal))
        .catch((error: unknown) => {
          console.error("Failed to load asset library", error);
          setLoading(false);
        });
    },
  });
}

const PICKER_POPUP = {
  size: "picker",
  surface: "solid",
  side: "bottom",
  align: "start",
  sideOffset: 8,
  collisionPadding: 16,
} satisfies Partial<Parameters<typeof Select.Content>[0]>;

/** One inline setting → a prompt-box pill that opens a compact `Select` picker. */
function PillSelect({
  setting,
  value,
  onValueChange,
}: {
  setting: PromptSettingOption;
  value: string;
  onValueChange: (value: string) => void;
}) {
  return (
    <Select.Root value={value} onValueChange={(next) => onValueChange(String(next))}>
      <Select.Trigger
        bare
        render={
          <PromptBox.Pill
            start={setting.start}
            end={<Icon as={IconChevronDownSmallOutlined} size="sm" />}
          />
        }
      >
        <Select.Value>
          {(value: string) =>
            setting.options.find((option) => option.value === value)?.title ?? value
          }
        </Select.Value>
      </Select.Trigger>
      <Select.Content {...PICKER_POPUP}>
        {setting.options.map((option) => (
          <Select.Item key={option.value} value={option.value}>
            {option.subtitle != null ? (
              <Select.ItemContent>
                <Select.ItemText>{option.title}</Select.ItemText>
                <Select.ItemDescription>{option.subtitle}</Select.ItemDescription>
              </Select.ItemContent>
            ) : (
              <Select.ItemText>{option.title}</Select.ItemText>
            )}
            <Select.ItemIndicator />
          </Select.Item>
        ))}
      </Select.Content>
    </Select.Root>
  );
}

export interface StudioPromptBoxProps {
  /** Generation modes (vertical rail). The rail shows only when there are ≥2. */
  modes: PromptModeOption[];
  /** Controlled active mode id. */
  mode: string;
  /** Fired when the active mode changes. */
  onModeChange: (id: string) => void;
  /** Inline setting pills. At most `MAX_INLINE_SETTINGS` are accepted. */
  settings: PromptSettingOption[];
  /** Controlled values keyed by setting id. */
  settingValues: Record<string, string>;
  /** Fired whenever a setting changes. */
  onSettingChange: (id: string, value: string) => void;
  /** Upload tiles ("very important settings") — capped at `MAX_UPLOADS`. */
  uploads: PromptUploadOption[];
  /** Real persisted media + upload path used by every picker in this dock. */
  assetLibrary: StudioAssetLibrary;
  /** The global add-media picker selected an item. */
  onAddMedia: (selection: AssetSelection) => void;
  /** A named Product/Avatar tile selected a replacement. */
  onUploadSelect: (id: string, selection: AssetSelection) => void;
  /** Remove a selected named Product/Avatar reference. */
  onUploadRemove: (id: string) => void;
  /** Show the sliders pill that opens the template picker. Default `true`. */
  showTemplatePicker?: boolean;
  /** Fired when a template is picked. */
  onSelectTemplate: (template: TemplateItem) => void;
  /** Prompt field placeholder. */
  placeholder?: string;
  /** Controlled prompt text shared by every Studio dock. */
  prompt: string;
  onPromptChange: (value: string) => void;
  /** Generate CTA cost. */
  cost?: ReactNode;
  /** Generate CTA struck-through original cost (promo). */
  oldCost?: ReactNode;
  /** Real generation submit action. */
  onGenerate: () => void;
  submitting?: boolean;
  generateDisabled?: boolean;
  /** Visible submit/validation failure. */
  error?: ReactNode;
  /** Dock skin — `glass` for the floating after-state bar. */
  surface?: ComponentProps<typeof PromptBox.Root>["surface"];
  /** Root-pane classes (width / pointer-events). */
  className?: string;
}

export function StudioPromptBox({
  modes,
  mode,
  onModeChange,
  settings,
  settingValues,
  onSettingChange,
  uploads,
  assetLibrary,
  onAddMedia,
  onUploadSelect,
  onUploadRemove,
  showTemplatePicker = true,
  onSelectTemplate,
  placeholder = "Describe the scene you imagine...",
  prompt,
  onPromptChange,
  cost,
  oldCost,
  onGenerate,
  submitting = false,
  generateDisabled = false,
  error,
  surface,
  className = "w-[830px] max-w-full",
}: StudioPromptBoxProps) {
  // Contract: switch modes only when they genuinely differ → rail needs ≥2.
  const showModeRail = modes.length >= 2;

  if (settings.length > MAX_INLINE_SETTINGS) {
    throw new Error(`StudioPromptBox accepts at most ${MAX_INLINE_SETTINGS} inline settings.`);
  }
  if (uploads.length > MAX_UPLOADS) {
    throw new Error(`StudioPromptBox accepts at most ${MAX_UPLOADS} upload tiles.`);
  }

  const handleMode = (id: string) => {
    onModeChange(id);
  };

  return (
    <PromptBox.Root surface={surface} className={className}>
      <PromptBox.ModeRail hidden={!showModeRail}>
        {modes.map((m) => (
          <PromptBox.Mode
            key={m.id}
            active={mode === m.id}
            onClick={() => handleMode(m.id)}
            start={<Icon as={m.icon} size="md" />}
          >
            {m.label}
          </PromptBox.Mode>
        ))}
      </PromptBox.ModeRail>

      <PromptBox.Body>
        <PromptBox.Field
          placeholder={placeholder}
          aria-label={placeholder}
          value={prompt}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onPromptChange(event.target.value)}
        />
        {error != null ? (
          <p className="px-3 pb-1 text-q-caption-sm-regular text-q-text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <PromptBox.Actions>
          <DeferredAssetLibraryModal
            items={assetLibrary.items}
            onUpload={assetLibrary.onUpload}
            pagination={assetLibrary.pagination}
            onSelect={onAddMedia}
            trigger={
              <PromptBox.Pill
                iconOnly
                aria-label="Add media"
                start={<Icon as={IconPlusMediumOutlined} size="sm" />}
              />
            }
          />
          {settings.map((setting) => (
            <PillSelect
              key={setting.id}
              setting={setting}
              value={settingValues[setting.id] ?? setting.defaultValue}
              onValueChange={(value) => onSettingChange(setting.id, value)}
            />
          ))}
          {showTemplatePicker ? (
            <TemplatePickerModal
              onSelect={onSelectTemplate}
              trigger={
                <PromptBox.Pill
                  iconOnly
                  aria-label="Choose template"
                  start={<Icon as={IconSettingsSliderHorOutlined} size="sm" />}
                />
              }
            />
          ) : null}
        </PromptBox.Actions>
      </PromptBox.Body>

      <PromptBox.Uploads hidden={uploads.length === 0}>
        {uploads.map((tile) => (
          <div key={tile.id} className="relative size-20 shrink-0">
            <DeferredAssetLibraryModal
              items={assetLibrary.items}
              onUpload={assetLibrary.onUpload}
              pagination={assetLibrary.pagination}
              onSelect={(selection) => onUploadSelect(tile.id, selection)}
              trigger={
                <PromptBox.Upload
                  label={tile.label}
                  src={tile.selection?.src}
                  mediaType={tile.selection?.kind === "video" ? "video" : "image"}
                  alt={typeof tile.label === "string" ? tile.label : "Selected reference"}
                />
              }
            />
            {tile.selection != null ? (
              <button
                type="button"
                aria-label={`Remove ${typeof tile.label === "string" ? tile.label : "reference"}`}
                className="absolute right-1 top-1 z-10 flex size-5 items-center justify-center rounded-q-full bg-q-transparent-dark-60 text-q-icon-primary backdrop-blur-sm hover:bg-q-transparent-dark-80"
                onClick={() => onUploadRemove(tile.id)}
              >
                <Icon as={IconCrossSmallOutlined} size="xs" />
              </button>
            ) : null}
          </div>
        ))}
      </PromptBox.Uploads>

      <PromptBox.Generate
        cost={submitting ? undefined : cost}
        oldCost={submitting ? undefined : oldCost}
        onClick={onGenerate}
        disabled={submitting || generateDisabled}
      >
        {submitting ? "Submitting…" : "Generate"}
      </PromptBox.Generate>
    </PromptBox.Root>
  );
}
