# App layout — adapt the shipped code in place

<!-- shared:header:begin — keep identical across all templates (scripts/check-agents-sync.sh) -->

A `type: "app"` product must look and feel like a Higgsfield product. This
template ships ONE ready-made layout screen as REAL CODE, already wired as the
home page (`src/routes/index.tsx`). **Adapt it in place** — swap its inputs,
copy, media, and wiring for the product you are building; never rebuild the
screen from scratch, fork a new top-level structure, or swap layouts. Build a
custom shell only when the user asks for something the layout cannot cover.

**Adapt in place does NOT mean ship the demo.** The layout is only the UI
shell, filled with placeholder data and stub flows. The deliverable is the
USER'S product: replace the demo data and flows with complete, working
business logic — the app's actual features, state, generation wiring, and
persistence — so it does what the user asked end-to-end and serves them as
well as you can. A template that merely renders is not done.

Everything shared lives in **`../components/AGENTS.md`** — the mandatory
component contract (asset library, generation tiles, feeds, progressive
disclosure), the design invariants (dark theme, no app header, container
width, buttons, icons), and copy-paste wiring. Read it before editing. Backend
wiring (submit, poll, uploads): `app/packages/fnf-react/ai/AGENTS.md`.
<!-- shared:header:end -->

## The layout

| Layout     | File                                        | When to use                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Studio** | `src/layouts/studio.tsx` (`StudioTemplate`) | The DEFAULT, richest shell — a full creative workspace: projects-first left `Sidebar` + hero + a floating prompt dock (`StudioPromptBox` from `@/components/studio-prompt-box`) over an edge-to-edge generations feed. **Pick Studio whenever the app is MORE than a one-shot or preset generator** — a professional tool where the PROMPT is a central input, there are MANY settings, and/or the user works across projects with a browsable feed. (Single quick action → app-detail; preset gallery → preset.) |

## Studio-specific rules

- **Everything visible in the shipped Studio is MOCK content.** Replace every
  product-specific string and image while generating the app: product/title
  copy, hero text, descriptions, nav/tool/project names, presets, thumbnails,
  covers, examples, and generation-feed media. Generate bespoke app-relevant
  imagery instead of reusing `/presets/*`. No shipped demo identity or content
  (`Marketing Studio`, `Aurora Labs`, `UGC Gadget save me`, etc.) may remain in
  the finished app. Universal controls such as `Home`, `All Generations`, and
  `Generate` may remain only when they accurately describe their real action.
- **Hero identity is mandatory output proof.** Always generate three coherent,
  app-specific examples of what the Studio actually outputs and pass them to
  `HeroComposition` as left support, central focal, and right support frames.
  The center must show the primary output; the sides show complementary outputs.
  Never omit the composition, reuse unrelated stock/mock images, or replace it
  with an eyebrow label.
- **The atmospheric hero background is structural, not optional decoration.**
  Keep the radial glow, dense dot field, and their fading masks behind the hero
  (`HERO_GLOW`, `HERO_DOTS`, `HERO_DOTS_MASK`). Colors may adapt to the app, but
  never flatten the area to a plain background, remove the dots, or remove the
  glow while replacing hero content.
- **Explore templates are mandatory.** Always generate at least **two distinct,
  app-specific templates** and render them through `ExamplePresets` /
  `TemplateCard` with real preview media, title, subtitle, and working Try action.
  The Explore tab and its grid must never be omitted or treated as optional,
  even when the app also has projects.
- **Keep the six structural parts intact — swap only the CONTENT inside them:**
  1. the projects-first left `Sidebar`,
  2. the glow + dot-field atmosphere,
  3. the output-example hero (`HeroComposition`),
  4. the floating prompt dock (`StudioPromptBox` from
     `@/components/studio-prompt-box` — mode toggle, inline setting pills,
     lime GENERATE),
  5. the `Explore` / `My Projects` section (Explore has at least two templates),
  6. the edge-to-edge `UserGenerations` feed.

  Change the app's OWN inputs, setting pills, copy, media, project/nav items,
  and wiring — but do NOT delete the prompt dock, collapse the sidebar away,
  drop the feed, or re-center the layout into a `max-w-*` page. If honoring
  the app requires removing a pillar, you picked the WRONG template — switch
  layouts rather than mangling Studio until it no longer reads as Studio.

- Studio is the one FULL-BLEED shell — no `max-w-7xl` container (sidebar +
  edge-to-edge feed under the dock).
- The prompt dock is always `StudioPromptBox`; the low-level `PromptBox`
  primitive is only for building another shared dock component (see the
  catalog in `../components/AGENTS.md`). Its bottom scrim is always one smooth
  vertical fade from 0% background opacity at the top to 100% at the viewport
  bottom; never place a flat solid block behind or below the composer.
- **Navigation owns the workspace view.** Never add a floating Before/After
  preview toggle. `Home` opens the creation hero; `All Generations` must always
  open `UserGenerations` populated with every generation created by the current
  user in this app. Do not add a Community tab or mix public generations into
  this view. The gallery density slider sits in the same header row as
  `All Generations`; do not add a second `Your generations` heading below it.
- **Projects are real app projects.** The sidebar Projects section lists only
  projects created inside this app. Its `+` action must always open
  `ProjectCreateModal`, containing exactly one required field: project name.
  Submitting persists the project and immediately adds it to the list. The
  scaffold already stores projects and generation links in user/workspace-
  scoped D1 tables; do not replace that with component state or browser-only
  storage. A generation launched from a project view must persist that
  `projectId`; unassigned Home/All generations stay visible only in All.
  `createdAt` comes from FNF. Each project's sidebar thumbnail shows its latest
  loaded ready generation (`src`, which is the poster for video), with a letter
  fallback until the first completed result is available.
  Every populated project row has a right-side `…` action revealed on hover.
  Its dropdown must support Rename (one required name field) and confirmed
  Delete. Both operations persist through the scoped project server functions;
  deleting a selected project returns the user to `All Generations` and keeps
  the underlying generations there.
  When there are no projects, the section MUST render the compact `Add project`
  row (24px glass plus tile + secondary label, Figma 22377:50195) and open the
  same `ProjectCreateModal`; never leave the section blank or seed fake projects
  just to avoid the empty state.
- **Each project is an isolated workspace.** Keep an explicit `activeProjectId`.
  Clicking a project in the sidebar or `My Projects` selects it and opens that
  project's creation workspace. Every Generate submission MUST read the active
  project and persist the new generation with that `projectId`; never generate
  into a global/default bucket after a project was opened. Project views show
  only that project's generations, drafts, prompt, uploads, and settings; switching
  projects must not leak state across workspaces. `All Generations` remains the
  only aggregate view across projects. Creating a project selects it immediately.
- **The workflow is already prewired.** `StudioTemplate` owns one controlled
  prompt/settings/media state for both docks, submits Seedance through
  `useGenerationRun`, prepends jobs to the FNF cache, and forwards the real
  cursor into the virtualized feed. Adapt its model/input mapping in place;
  never restore optional `generations` props, fake paging, local-only projects,
  or separate prompt states.
- **Sidebar app identity = the generated favicon.** Generate a square app icon
  as part of the app build, save/set it through `src/app-meta.json` as
  `favicon_url`, and keep `Sidebar.Logo` wired to `appFaviconUrl` from
  `@/lib/app-meta`. The browser favicon and sidebar logo must always show the
  same generated image. Never replace the sidebar image with a Lucide icon,
  emoji, initials, or unrelated placeholder once the favicon exists.

## Responsive contract

- Keep the persistent sidebar at `lg` and above. Below `lg`, give the workspace
  the full width and expose the same `StudioSidebar` content in a left-side
  Quanta modal sheet with a backdrop and an accessible open button. Do not
  create a second navigation model or duplicate project data.
- The mobile sheet must close through its header control and after Home, All
  Generations, or project navigation. Each item must call the existing
  `onViewChange` path before closing the sheet. Let Quanta retain focus,
  backdrop, and Escape-key behavior.
- Stack the prompt dock below `640px`, keep its actions horizontally usable,
  and reserve enough feed space above the dock for the taller mobile
  composition. `HeroComposition` must stay inside the workspace width, and
  `ExamplePresets` must render one column on phones and two from `sm`.
- Responsive work is presentation-only unless the product request explicitly
  changes behavior. Do not alter generation approval, submit, polling, cache,
  feed pagination, project persistence, active-project ownership, uploads,
  settings, or durable-reference logic to solve a layout problem.
- Before finishing a layout change, inspect Home, All Generations, and a project
  view at `320px`, `390px`, `768px`, `1024px`, and `1440px`. Open and close the
  mobile sheet, navigate through each item type, inspect the prompt dock in
  idle and generation states, and check for horizontal overflow or hidden
  actions.
