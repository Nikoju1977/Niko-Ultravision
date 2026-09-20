# Shared app components — the cross-app contract

These components are the single source of truth for the core interactions
every Higgsfield app must share. **IMPORT them — never copy, fork, or
hand-roll a replacement.** Missing a prop? Extend the component here
(backward compatible); never build a private variant inside a route or layout.

<!-- shared:rules:begin — keep identical across all templates (scripts/check-agents-sync.sh) -->

## Hard rules (apply to EVERY app)

1. **Assets / uploads → `AssetLibraryModal`** behind EVERY "+" / upload /
   attach / add-media action — never a custom picker or upload modal. Trigger
   UI: `UploadField` in creation rails, `Dropzone` in the app-detail hero. In
   a real app it MUST be WIRED — `items`, `onUpload`, `onSelect`, and
   `pagination` (see "Wiring" below);
   shipping it unwired (demo grid, preview-only uploads) is a bug. Every large
   upload/select tile uses the canonical `UploadField` / `Dropzone` glass
   image-field style (Figma 3313:51149); never hand-roll or visually simplify
   this surface.
2. **One generation → `GenerationTile`** everywhere (feed tile, wizard result,
   hero result, variation cell). Busy = `state="generating"`; lightbox is
   always `GenerationDetailModal` (via the tile's `detail` prop); hover rail
   is `CardActions` (≤3 actions, rest in ⋯). Never hand-roll spinners, result
   tiles, hover overlays, or lightboxes. A `Grid` of tiles is ONLY for a
   finite "pick the best of these" set inside a wizard/generator — not a feed.
   Every action with `id: "download"` automatically downloads the generation's
   original image/video through `downloadMedia`; never ship a Download control
   without a real media URL.
3. **A browsable feed of the user's OWN generations → `UserGenerations`**
   (History, "all generations", after-generate results). Personal only —
   never a public/community feed. `@/components/gallery` is its private
   internals — never import it or hand-roll a masonry. `HistoryGrid` is a
   deprecated alias. Keep mapped `items` and load callbacks referentially
   stable. A client-filtered subset of a global cursor must use explicit
   paging instead of auto-loading the entire global history to fill itself.
4. **Pick-one-option choosers → `TemplateModal`** (presets, styles, any grid
   of selectable tiles).
5. **Progressive disclosure.** A panel shows only its PRIMARY inputs + the
   costed Generate CTA; every secondary choice collapses under a Quanta
   `Accordion` (`multiple={false}`) — never a flat always-open list, never a
   hand-rolled collapsible. Creation-rail budget: at most 3 large fields
   (`UploadField` / cover `MediaCard` / `Dropzone`) + 4 compact
   (`SettingTrigger` / `Select`) visible; the rail scrolls
   (`overflow-y-auto`) and the CTA stays pinned via `RailFooter`.
6. **Every visible action must work end-to-end.** Never render an inert button,
   placeholder handler, empty menu, or `onClick={() => {}}`. In
   `GenerationDetailModal` and `CardActions`: Download uses the real media URL;
   Like updates persisted liked state; Share uses Web Share with a clipboard
   fallback; Delete confirms and removes the persisted item; More opens a real
   menu whose rows are wired; and the primary CTA starts its actual generation
   workflow. If an action cannot be implemented, hide it instead of showing a
   dead control. Verify each action by clicking it before delivery.
7. **Generation identity must be real.** Every `GenerationDetailModal` receives
   `generation.author` from the authenticated profile or generation owner:
   `{ name, avatarSrc, role }`. For the current user's generations, use the
   current user's display name and avatar; use email/initials only as loading
   fallbacks. Never ship hardcoded demo identities such as `retro_strawberry`,
   a fake initial, or an unrelated avatar. Map the owner through `GalleryItem`
   into `GenerationTile` so the InfoPanel header always renders real identity.
8. **Screen empty states use `ScreenEmptyState`.** Every empty page/feed renders
   the shared dotted-fade composition with three representative generations
   from that app, plus real title/description and an optional working action.
   Never ship a text-only empty screen, generic illustration, or unrelated media.

## Design invariants (every screen)

- **No app header/top bar, no breadcrumbs, no credits/sign-out UI** — the
  Higgsfield host chrome owns those. In-app nav = Quanta `Sidebar` or inline
  controls; a page title is a heading in the content area.
- **Permanently DARK** — `data-theme="default-dark"` pinned in
  `src/routes/__root.tsx`; no theme toggle, no light mode, no `dark:` styling.
- **Container** `mx-auto w-full max-w-7xl` on the shell (exception: a
  full-bleed workspace shell like Studio).
- **Buttons** — variant names lie: `primary` = LIME, `secondary` = WHITE,
  `tertiary` = dark glass, `ghost` = transparent. Nav/ordinary actions use
  `tertiary`/`ghost`. The generation CTA is ALWAYS `marketingPrimary` with the
  cost inside: `{label} {sparkles} {credits}` (sparkle =
  `@/assets/icon-sparkles-soft.svg?react`, 14px; credits inherit the label
  font; `Loader size="xs" color="neutral"` while busy). Pass `size="md"`
  explicitly (Quanta defaults to `sm`); `sm`/`xs` only in dense toolbars.
- **Icons** — lucide only, by name, via the Quanta `Icon` wrapper
  (`import { Sparkle } from "lucide-react"` → `<Icon as={Sparkle} />`).
- **Prompt surfaces** — the shipped dock components (`Composer` / `PromptBox`;
  in the studio template the canonical dock is `StudioPromptBox`) — never
  hand-rolled.
- **Compose from Quanta + `cn`.** Gaps (date picker, table, …) → build a small
  component HERE from Quanta primitives + `q-` tokens. Never a third-party UI
  library, never modify or restyle the vendored `@higgsfield/quanta`.
- **Real copy in every state** (empty, busy, error) — no placeholder tokens.
- **Don't chase lint/type noise** — `bun run lint`/`typecheck` ship clean;
  anything reported is from YOUR changes. Never reformat shipped template
  files or vendored `packages/`.

<!-- shared:rules:end -->

Studio-only exception: gradient `IconTile` artwork uses Phosphor's real
`weight="fill"` glyphs; all ordinary controls still use named Lucide icons.

## Component catalog

| Component                              | Import                              | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AssetLibraryModal`                    | `@/components/asset-library`        | THE asset picker modal — tabs, scope, search, virtualized paging, and upload all work; live mode wires `items`, `onUpload`, `onSelect`, and `pagination`. Every empty tab uses its private Figma-matched `No elements yet` state. Submit `item.ref`, never `item.src`.                                                                                                                                                                                   |
| `TemplateModal`                        | `@/components/template-modal`       | "Choose one option" modal — grid of image tiles, lime ring on the active one.                                                                                                                                                                                                                                                                                                                                                                           |
| `GenerationTile`                       | `@/components/generation-card`      | THE single-generation tile: `generating`/`ready`/`failed` states + click-to-open detail + capped `CardActions` rail. `actions` per context; badges/checkboxes via `children`; panel content via `detail`.                                                                                                                                                                                                                                               |
| `GenerationCard`                       | `@/components/generation-card`      | Low-level primitive `GenerationTile` composes — use only inside another shared component.                                                                                                                                                                                                                                                                                                                                                               |
| `CardActions`                          | `@/components/generation-card`      | The one hover action rail (≤3 glass buttons, rest in ⋯).                                                                                                                                                                                                                                                                                                                                                                                                |
| `GenerationDetailModal`                | `@/components/generation-detail`    | THE fullscreen viewer. Live mode requires `generation` and shows only actions the caller wires; `demo` is explicit. Layout fixed; content via `detailRows` / `primaryAction` / `actions`.                                                                                                                                                                                                                                                               |
| `UserGenerations`                      | `@/components/user-generations`     | THE personal generations feed — live mode requires real `items` plus cursor callbacks; virtualized masonry + hover actions + detail modal + generating card.                                                                                                                                                                                                                                                                                            |
| `ScreenEmptyState`                     | `@/components/screen-empty-state`   | Shared full-screen empty state: dotted fade background, three representative app generations, title, description, and optional action.                                                                                                                                                                                                                                                                                                                 |
| `HistoryGrid`                          | `@/components/history-grid`         | **Deprecated** prop-forwarding alias of `UserGenerations`.                                                                                                                                                                                                                                                                                                                                                                                              |
| `Dropzone` / `DropzonePreview`         | `@/components/dropzone`             | Bordered upload/select tile (app-detail hero); `preview` = after-selection state. `AssetLibraryModal` trigger.                                                                                                                                                                                                                                                                                                                                          |
| `UploadField`                          | `@/components/upload-field`         | THE rail upload field (icon-chip empty state, ringed `preview` + remove). `AssetLibraryModal` trigger in any rail.                                                                                                                                                                                                                                                                                                                                      |
| `RailFooter`                           | `@/components/rail-footer`          | Pinned Generate-CTA footer for a rail (`sticky bottom-0` + scrim).                                                                                                                                                                                                                                                                                                                                                                                      |
| `SignInModal`                          | `@/components/sign-in-modal`        | Guest Generate gate: Figma-matched Higgsfield login dialog; its CTA enters the same-origin `/__auth/login` flow.                                                                                                                                                                                                                                                                                                                                         |
| `Composer`                             | `@/components/composer`             | Side-rail prompt pane with `Composer.Action` footer pills.                                                                                                                                                                                                                                                                                                                                                                                              |
| `StudioPromptBox`                      | `@/components/studio-prompt-box`    | THE canonical Studio prompt dock — config-driven `PromptBox` composition: `modes` (shown when ≥2), `settings` (at most 2 inline pills; extra settings require a separately implemented advanced surface), `uploads` (capped at 2 with explicit removal). Its "+" add-media pill is mandatory, always visible, and always opens `AssetLibraryModal`; never remove, hide, or replace it. Use this component, never a hand-rolled `PromptBox` composition. |
| `PromptBox`                            | `@/components/prompt-box`           | Low-level dock PRIMITIVE `StudioPromptBox` composes — use directly only when building another shared dock component.                                                                                                                                                                                                                                                                                                                                    |
| `MediaCard`                            | `@/components/media-card`           | Cover/preview card; `ratio` picks landscape vs portrait.                                                                                                                                                                                                                                                                                                                                                                                                |
| `TemplatePickerModal` / `TemplateCard` | `@/components/template-picker`      | Category/type-filtered template gallery (`TemplateCard`: `single` base + `triptych` variant). The entire card is keyboard/click actionable and applies the template; never limit activation to its CTA only.                                                                                                                                                                                                                                           |
| `ExamplePresets`                       | `@/components/example-presets`      | THE "what you can make" showcase — filter-tabs over a `TemplateCard` grid; clicking anywhere on a card reports the pick through `onUse` so the screen seeds its prompt box. Use for before-state examples, never a hand-rolled grid.                                                                                                                                                                                                                     |
| `HeroComposition`                      | `@/components/hero-composition`     | Three-shot Studio hero identity: two supporting frames behind one larger focal frame. Always replace all three sources with a coherent set generated specifically for the app.                                                                                                                                                                                                                                                                          |
| `MyProjects`                           | `@/components/my-projects`          | Reusable Cinema Studio project overview — async new-project trigger, all-generations entry, real project counts, and neutral/real preview mosaics.                                                                                                                                                                                                                                                                                                      |
| `ProjectCreateModal`                   | `@/components/project-create-modal` | The sidebar `+` project flow. It contains exactly one required project-name field and reports the created name through `onCreate`; never add setup steps or extra fields.                                                                                                                                                                                                                                                                               |
| `ProjectActions`                       | `@/components/project-actions`      | Hover-revealed sidebar `…` dropdown with persistent Rename and confirmed Delete flows. Keep it in the Sidebar `action` sibling slot, never nest it inside the project-row button.                                                                                                                                                                                                                                                                      |
| `SettingTrigger`                       | `@/components/setting-trigger`      | Labelled setting row that opens a picker.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `StepRail`                             | `@/components/step-rail`            | Numbered wizard step indicator; completed = check, reached = clickable.                                                                                                                                                                                                                                                                                                                                                                                 |
| `BeforeAfterCompare`                   | `@/components/before-after-compare` | Draggable before↔after slider (pointer + keyboard) for enhance/upscale payoffs.                                                                                                                                                                                                                                                                                                                                                                         |
| `IconTile`                             | `@/components/icon-tile`            | Small gradient icon tile for sidebars/nav rows. Pass a Phosphor glyph; gradient tiles render its real `weight="fill"` variant. Do not pass Lucide outlines or fake fill with CSS.                                                                                                                                                                                                                                                                       |

## Preset tiles: horizontal or vertical orientation

Chosen **per app**, never hardcoded. Horizontal = 16:9 tiles, 3 columns;
vertical = 9:16, denser. Match the app's output (vertical for shorts/9:16
apps) and drive tile shape with `MediaCard`'s `ratio` prop rather than a
bespoke aspect ladder.

<!-- shared:wiring:begin — keep identical across all templates (scripts/check-agents-sync.sh) -->

## Wiring `AssetLibraryModal`

Trigger-based: your clickable element goes in `trigger`, the chosen asset
arrives in `onSelect`. Interactions (filtering, search, virtualized scrolling,
upload busy/error, select-and-close) work out of the box — a REAL app wires all
four live props:

- **`items: AssetLibraryItem[]`** — durable FNF media uploads plus mapped FNF
  generations, with `kind` (`"upload" | "image" | "video"`), `personal`,
  and optional `liked` metadata. Never mix uploads into generation history.
- **`onUpload: (file) => Promise<AssetSelection>`** — multipart `FormData`
  POST to the same-origin app route → `media.upload(...)` server-side → resolve
  `{ name, type, src, ref }`, where `ref` is the durable FNF `MediaRef`.
- **`onSelect: (item) => void`** — store the chosen item in controlled app
  state. Generation submits use `item.ref`, NEVER `item.src`; `src` can be
  a browser-local preview URL.
- **`pagination`** — independent cursor/loading/error/load-more state for each
  backed tab. Upload and generation cursors stay separate. Filtered search uses
  explicit pagination instead of silently fetching the whole account.

```tsx
const liveLibraryProps = {
  items: libraryItems,
  onUpload: (file: File) => uploadToMediaRoute(file),
  onSelect: (item: AssetSelection) => setSource(item),
  pagination: {
    uploads: uploadPage,
    image: imageGenerationPage,
    video: videoGenerationPage,
  },
};

<AssetLibraryModal
  {...liveLibraryProps}
  trigger={(
    <Dropzone
      render={<button type="button" />}
      icon={IconAddPhoto}
      title="Upload Image"
      subtitle="PNG, JPG or Paste from Clipboard"
      preview={image != null ? <DropzonePreview src={image} alt="Selected image" /> : undefined}
    />
  )}
/>

// Other trigger shapes keep the same live props:
<AssetLibraryModal {...liveLibraryProps} trigger={<PromptBox.Pill iconOnly aria-label="Add media" start={<Icon as={IconPlus} size="sm" />} />} />
<AssetLibraryModal {...liveLibraryProps} trigger={<Composer.Action start={<Icon size="sm" as={IconPlus} />}>Attach files</Composer.Action>} />
```

**Trigger silently not opening?** `trigger` renders AS the modal trigger
(Base UI `render` prop) — it must spread incoming props (`onClick`, `ref`,
aria) onto a real DOM node. Quanta and `@/components/*` all do; a custom
component that drops unknown props won't open. Fix: forward props, or wrap in
`<button type="button" className="contents">…</button>`.

## Generation lifecycle

One state machine everywhere: `idle → generating → result`.

```tsx
{
  stage === "generating" && <GenerationTile state="generating" ratio="portrait" />;
}
{
  stage === "result" && (
    <GenerationTile
      ratio="portrait"
      generation={{ src: resultUrl, mediaType: "image", prompt }}
      actions={[{ id: "download", label: "Download", icon: IconDownload }]}
    />
  );
}
```

Helpers in `src/lib/higgsfield-generation-results.ts` map a Generation to its
preview media. Backend wiring (submit, poll, uploads):
`app/packages/fnf-react/ai/AGENTS.md` — `useGenerationRun` drives the
`generating` prop, `useAttachments` uploads picked files.

## Adding a new shared component

Build it here from Quanta primitives + `q-` tokens (never a third-party UI
lib), export via `index.ts`, add a catalog row above.

## Placeholder demo assets

Shipped demo media (`/presets/*.png` + hardcoded demo data) is PLACEHOLDER
art, marked with greppable "PLACEHOLDER ASSETS" comments. In a real app,
replace product-representing media (hero/example outputs, covers,
before/after samples, feed items) with bespoke assets generated via the
Higgsfield tools. Style-picker label thumbnails may stay simple when real
output depends on the user's upload.

<!-- shared:wiring:end -->

In this Studio scaffold, live-mode types make `items`, `onUpload`, `onSelect`,
and `pagination` mandatory. Trigger-only snippets above are schematic; every real
Studio call site must pass all four callbacks/data props, while `demo` remains
an explicit isolated-preview opt-in only. Cursor-page each live tab through its
`pagination` entry (`hasMore`, `loading`, `error`, `onLoadMore`) so scrolling
fetches only that tab. Never eager-load `size: 100` or collapse tab
loading/error state into one global flag.
