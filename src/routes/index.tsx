import { createFileRoute } from "@tanstack/react-router";
import { StudioTemplate } from "@/layouts/studio";

export const Route = createFileRoute("/")({
  // No title/description here on purpose: the home page inherits the app's
  // editable page metadata from the root route (set via the marketplace meta
  // API — title/favicon/og), so a shared link to "/" shows the owner's values.
  // Add a `head` here only to give a SPECIFIC page its own title/description
  // (a deeper route's head overrides the root's for that page).
  component: Index,
});

// The shipped StudioTemplate layout, wired as the home page. Adapt it in place —
// src/layouts/AGENTS.md is the contract. Routes are server-rendered: keep
// render SSR-safe (no window/document at module top level or during render).
function Index() {
  return <StudioTemplate />;
}
