import { expect, test } from "bun:test";
import {
  fetchCurrentUser,
  getFnfScopeKey,
  getSignInUrl,
  GUEST_SCOPE_KEY,
  uploadAsset,
} from "../src/lib/fnf.browser";

test("detects auth through the same-origin user route", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    expect(input).toBe("/api/user");
    expect(init?.credentials).toBe("include");
    calls += 1;
    return calls === 1
      ? new Response(null, { status: 401 })
      : Response.json({ id: "user-1", workspaceId: "workspace-1" });
  };

  try {
    expect(await fetchCurrentUser()).toBeNull();
    expect(await fetchCurrentUser()).toEqual({ id: "user-1", workspaceId: "workspace-1" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("opens the public app under a guest scope", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 401 });

  try {
    expect(await getFnfScopeKey()).toBe(GUEST_SCOPE_KEY);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sends only guests through the app auth route", () => {
  expect(getSignInUrl(GUEST_SCOPE_KEY, "/projects?view=all")).toBe(
    "/__auth/login?return=%2Fprojects%3Fview%3Dall",
  );
  expect(getSignInUrl("user-1:workspace-1", "/projects")).toBeNull();
  expect(getSignInUrl(GUEST_SCOPE_KEY, "//evil.example")).toBe(
    "/__auth/login?return=%2F",
  );
});

test("normalizes uploaded image refs before they reach generation input", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    expect(input).toBe("/api/media/upload");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeInstanceOf(FormData);
    return Response.json({
      ok: true,
      ref: {
        id: "97cf1fec-77a9-4627-a3d4-23a09ea8aaa4",
        type: "image",
        url: "https://cdn.example/upload.png",
      },
      url: "https://cdn.example/upload.png",
    });
  };

  try {
    const asset = await uploadAsset(new File(["image"], "upload.png", { type: "image/png" }));
    expect(asset).toMatchObject({
      src: "https://cdn.example/upload.png",
      ref: {
        id: "97cf1fec-77a9-4627-a3d4-23a09ea8aaa4",
        type: "media_input",
        url: "https://cdn.example/upload.png",
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
