import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { FnfProvider } from "@higgsfield/fnf-react";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { button } from "@higgsfield/quanta/button";
import { NotFound } from "@higgsfield/quanta/not-found";

import appCss from "../styles.css?url";
import { appMeta, toOwnAssetUrl, type AppMeta } from "../lib/app-meta";
import { reportHiggsfieldError } from "../lib/higgsfield-error-reporting";
import {
  fnfBrowserAdapter,
  getFnfScopeKey,
  GUEST_SCOPE_KEY,
  STUDIO_JOBS,
} from "../lib/fnf.browser";
// Page metadata (browser <title>/favicon + social og: tags) committed into the
// repo by the marketplace meta API and read at BUILD time — no runtime fetch.
// Editing it via the app settings UI rewrites this file and redeploys the app.

declare const __HF_DESIGN_INSPECTOR__: boolean;

// Built-in defaults for any field that isn't set in app-meta.json.
const DEFAULT_TITLE = "Higgsfield App";
const DEFAULT_DESCRIPTION = "Higgsfield Generated Project";

// Build the document head (title / description / og: / twitter: / favicon) from
// app-meta.json, falling back to the defaults above for any unset field.
// og_title/og_description double as the browser <title> and meta description;
// og_image_url (when set) also drives the twitter card + image. Built from
// inline tag literals (conditional spreads for the optional image/favicon) so
// it matches the head() shape TanStack expects.
// favicon/og images live in THIS app's own /assets, so the host is never
// inherent. app-meta.json may carry an absolute higgsfield-app URL with a STALE
// host — baked from the app this one was copied/remixed/renamed from — which would
// serve the wrong app's favicon/og. Strip any higgsfield-app host (prod
// higgsfield.app + dev higgsfield-dev.app) down to a root-relative path so it
// always resolves against whoever serves THIS page (preview / prod / custom
// domain). Genuinely external URLs (a CDN image the owner set) are left absolute.
function buildHead(meta: AppMeta) {
  const title = meta.og_title ?? DEFAULT_TITLE;
  const description = meta.og_description ?? DEFAULT_DESCRIPTION;
  const ogImage = toOwnAssetUrl(meta.og_image_url);
  const favicon = toOwnAssetUrl(meta.favicon_url);
  const ogVideo = toOwnAssetUrl(meta.og_video_url);

  return {
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title },
      { name: "description", content: description },
      { name: "author", content: "Higgsfield" },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: ogImage ? "summary_large_image" : "summary" },
      { name: "twitter:site", content: "@Higgsfield" },
      ...(ogImage
        ? [
            { property: "og:image", content: ogImage },
            { name: "twitter:image", content: ogImage },
          ]
        : []),
      // Cover video (og:video) — the animated counterpart of og:image; the
      // Higgsfield feed cards also play it on hover.
      ...(ogVideo ? [{ property: "og:video", content: ogVideo }] : []),
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      ...(favicon ? [{ rel: "icon", href: favicon }] : []),
    ],
  };
}

function NotFoundComponent() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-q-background-primary px-4">
      <NotFound
        className="mx-auto max-w-md"
        icon={<span className="text-q-title-md-semi-bold text-q-text-primary">404</span>}
        title="Page not found"
        subtitle="The page you're looking for doesn't exist or has been moved."
      >
        <Link to="/" className={button({ variant: "primary", size: "md" }, "mt-3")}>
          Go home
        </Link>
      </NotFound>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportHiggsfieldError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-q-background-primary px-4">
      <div className="max-w-md text-center">
        <h1 className="text-q-title-lg-semi-bold text-q-text-primary">This page didn't load</h1>
        <p className="mt-2 text-q-body-sm-regular text-q-text-secondary">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className={button({ variant: "primary", size: "md" })}
          >
            Try again
          </button>
          <a href="/" className={button({ variant: "outline", size: "md" })}>
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  // Read the committed page metadata at build time (no runtime fetch).
  head: () => buildHead(appMeta),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="default-dark" style={{ colorScheme: "dark" }}>
      {/* Marketplace apps are permanently dark: data-theme is pinned on <html>
          above. Do not add quanta's bootstrapScript/ThemeController, a theme
          toggle, or a light mode. */}
      <head>
        <HeadContent />
      </head>
      <body className="bg-q-background-primary text-q-text-primary">
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  useEffect(() => {
    if (!__HF_DESIGN_INSPECTOR__) {
      return;
    }

    void import("../module/design-inspector/runtime")
      .then(({ installHiggsfieldDesignInspector }) => {
        installHiggsfieldDesignInspector();
      })
      .catch((error) => {
        reportHiggsfieldError(
          error instanceof Error ? error : new Error("Failed to load design inspector"),
          {
            boundary: "higgsfield_design_inspector_import",
          },
        );
      });
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ScopedApp />
    </QueryClientProvider>
  );
}

function ScopedApp() {
  const scope = useQuery({
    queryKey: ["fnf", "identity-scope"],
    queryFn: getFnfScopeKey,
    staleTime: 0,
    retry: false,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
  });

  if (scope.error != null) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-q-background-primary px-4">
        <div className="max-w-sm text-center">
          <h1 className="text-q-title-md-semi-bold text-q-text-primary">Studio couldn’t open</h1>
          <p className="mt-2 text-q-body-sm-regular text-q-text-secondary">
            {scope.error instanceof Error
              ? scope.error.message
              : "Your session could not be loaded."}
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <a
              href="/__auth/login?return=/"
              className={button({ variant: "primary", size: "md" })}
            >
              Sign in
            </a>
            <button
              type="button"
              className={button({ variant: "outline", size: "md" })}
              onClick={() => void scope.refetch()}
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <FnfProvider
      key={scope.data}
      adapter={fnfBrowserAdapter}
      jobs={STUDIO_JOBS}
      scopeKey={scope?.data ?? GUEST_SCOPE_KEY}
    >
      {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
      <Outlet />
    </FnfProvider>
  );
}
