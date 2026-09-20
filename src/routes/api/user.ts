import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/user")({
  server: {
    handlers: {
      GET: async () => {
        const upstream = await fetch("https://fnf.internal/user");
        const body = await upstream.text();

        return new Response(body, {
          status: upstream.status,
          headers: {
            "content-type": upstream.headers.get("content-type") ?? "application/json",
            "cache-control": "no-store",
          },
        });
      },
    },
  },
});
