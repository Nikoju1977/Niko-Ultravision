# Studio app scaffold contract

This directory is a starting scaffold for an AI-built product, not a finished
demo. Adapt the existing Studio layout in place and finish the real user flow
end to end. Rendering the shipped examples is not completion.

## Read before changing code

1. Read `src/layouts/AGENTS.md` before changing the screen structure.
2. Read `src/components/AGENTS.md` before composing UI or media controls.
3. For generation, uploads, profile data, or history, read
   `packages/fnf/ai/AGENTS.md` and `packages/fnf-react/ai/AGENTS.md` completely.
4. For component APIs and tokens, read `packages/quanta/ai/AGENTS.md`.
5. Do not modify vendored packages to work around an app-level problem.

## Objective and definition of done

The adapted app must preserve Studio's sidebar, hero, `StudioPromptBox`, and
`UserGenerations` feed while replacing their content and product behavior.
Completion is observable only when all of the following are true:

- Copy, fields, presets, metadata, navigation, and errors describe the user's
  product rather than this video-ad scaffold.
- Product-representing images and videos are user-supplied, generated for the
  app, or returned by its live generation flow. No shipped `/presets/*` media,
  repeated stand-in art, stock hotlink, emoji art, or CSS mock artwork remains.
- Upload, asset selection, project creation, Generate, credit estimation,
  submission/error, history pagination, project filtering, preview, and
  download/share behavior use real code and durable data.
- `bun run check:adapted`, `bun test`, `bun run lint`, `bun run typecheck`, and
  `bun run build` pass without weakening strict types or checks.

## Mandatory asset policy

Use assets in this order:

1. Use assets supplied by the user when they fit the requested role.
2. Otherwise use the available image-generation tool to create bespoke,
   on-brand media at the actual component aspect ratio.
3. Save build-time assets under meaningful stable paths such as
   `public/assets/examples/<name>.webp`, with useful alt text.
4. Runtime results use durable URLs returned by FNF.

Do not replace missing assets with placeholder services, random web images,
gradients, blank mock cards, or copied scaffold art. If generation tooling is
unavailable, state the missing requirement instead of silently mocking it.
After replacement, delete `public/presets/` and run `bun run check:adapted`.

## Prewired runtime boundaries — preserve these

- `src/lib/fnf.server.ts` is the only place that constructs the server-only
  Workflow Platform adapter for `https://fnf.internal`.
- `src/lib/fnf.functions.ts` is the validated JSON RPC boundary. Browser code
  must never call an internal URL or expose user/workspace credentials.
- `src/lib/fnf.browser.ts` owns the stable browser adapter, model registry,
  identity scope resolver, and multipart upload helper. `src/routes/__root.tsx`
  mounts one user/workspace-scoped `FnfProvider`; every FNF/custom query key,
  run controller, cache write, and invalidation must consume that scope.
- Keep generation approval in `src/lib/generation-approval.ts`: pass the exact
  `jobSetType` and `params` to the host-injected
  `window.hf.requestGeneration(...)`, then return its token to the fnf submit.
  Never use `window.confirm` or add a second security modal. An `AbortError` is
  user cancellation; a missing host API or any other failure must stay visible.
- Keep the app publicly viewable under the `guest` scope. Do not gate the root
  on authentication. A guest Generate click navigates through
  `/__auth/login?return=<current path>`; authenticated Generate reaches
  `requestGeneration(...)` for approval before the backend submit.
- `src/routes/api/media/upload.ts` accepts same-origin image uploads and calls
  `media.upload` server-side. Generation submits use `AssetSelection.ref`,
  never the preview URL in `src`.
- `src/layouts/studio.tsx` uses one controlled dock state in both Home and
  generation views. Do not fork the prompt state or reintroduce no-op controls.
- History uses `jobsFeedQueryOptions`, `flattenFeedPages`, and the real cursor.
  Keep `hasMore`/`loadingMore`/`onLoadMore` wired into `UserGenerations`.
- Generate is fire-and-forget after the backend returns job ids. Keep the CTA
  busy only during approval/submission; History owns live polling afterward.
- The justified gallery is virtualized by rows. Never unmount loaded media
  merely because scroll velocity is high; that caused the disappearing-image
  bug this scaffold explicitly fixes.
- Terminal jobs without previewable media remain visible as failed tiles; do
  not filter them out after users already saw their generating state.
- D1 stores app projects and generation/project links. Project rows must be
  scoped by the current FNF user/workspace. Do not pass a D1 UUID as FNF
  `folderId`: generated-app FNF exposes no folder-create API, so such an ID is
  not a valid backend folder.
- Plain Vite development has no Workers binding module, so project functions
  use a process-memory store only when `import.meta.env.DEV` is true. Deploys
  never use that fallback: they require D1, as declared in `app.manifest.json`.

## Interaction boundaries

- Every visible control must perform its named action. Wire it, disable it with
  an explanation, or remove it. Never leave fake Tools, Pricing/Login, Search,
  Like, Delete, or template actions for appearance.
- `AssetLibraryModal` live mode requires `items`, `onUpload`, `onSelect`, and
  `pagination` at the type level. Explicit `demo` mode is only for an isolated scaffold preview
  and must not appear in an adapted route/layout.
- `UserGenerations` live mode requires real items and cursor callbacks.
- `GenerationDetailModal` live mode requires a real generation and exposes
  only actions the caller actually wires.
- Project creation is asynchronous: keep the modal open while saving and show
  persistence failures. A project view filters the shared FNF cursor feed using
  the persisted app-owned generation link.
- Keep host-owned chrome out of the app: no duplicate login, pricing, credits,
  account, theme toggle, or top bar.

## TypeScript, SSR, and comments

- Keep strict TypeScript. Use exported SDK/component types and `import type`;
  do not add `any`, `@ts-ignore`, or `@ts-expect-error` to force a pass.
- Server-only code stays in `*.server.ts` or TanStack server handlers. Never
  touch `window`, `document`, `navigator`, or storage during SSR render or at
  module scope.
- Routes live in `src/routes`. Never hand-edit `src/routeTree.gen.ts`; running
  typecheck/build regenerates it.
- Reuse Quanta and existing shared components before adding an abstraction or
  dependency. Do not add another UI system.
- Keep comments only where they explain a non-obvious data, security, SSR, or
  package boundary. Remove obsolete demo instructions with the demo code.

## Required verification scenarios

- Generate from prompt only and from durable image/video references.
- Missing input, user confirmation cancel, out-of-credit/generation failure,
  upload failure, and project persistence failure.
- Empty history, populated history, short first pages, repeated cursor pages,
  and a project with only a few matching generations.
- Fast scrolling does not replace loaded images/videos with colored skeletons.
- Direct SSR load has no browser-global crash; keyboard focus and reduced
  motion remain usable; narrow viewports do not introduce a second app shell.
