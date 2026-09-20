import { describe, expect, test } from "bun:test";
import { ApiJobError } from "@higgsfield/fnf/errors";
import { isStructuredRequestError } from "../src/lib/request-errors.server";
import { applySecurityHeaders } from "../src/lib/security-headers.server";
import { validateUploadRequestHeaders } from "../src/lib/upload-request-security";

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

describe("Studio response security", () => {
  test("allows only the platform approval frames and preserves the response", async () => {
    const secured = applySecurityHeaders(
      new Response("ok", { status: 201, headers: { "x-app-header": "kept" } }),
    );

    expect(secured.status).toBe(201);
    expect(await secured.text()).toBe("ok");
    expect(secured.headers.get("x-app-header")).toBe("kept");
    expect(secured.headers.get("content-security-policy")).toContain(
      "frame-src 'self' https://auth.higgsfield.app https://auth.higgsfield-dev.app",
    );
    expect(secured.headers.get("content-security-policy")).not.toContain("frame-ancestors");
    expect(secured.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("Studio upload request security", () => {
  test("rejects a foreign origin before multipart parsing", () => {
    const request = new Request("https://app.example/api/media/upload", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect(validateUploadRequestHeaders(request, MAX_UPLOAD_BYTES)).toMatchObject({
      status: 403,
      code: "invalid_origin",
    });
  });

  test("rejects a declared oversize body and accepts an in-origin request", () => {
    const oversized = new Request("https://app.example/api/media/upload", {
      method: "POST",
      headers: {
        origin: "https://app.example",
        "content-length": String(MAX_UPLOAD_BYTES + 1),
      },
    });
    expect(validateUploadRequestHeaders(oversized, MAX_UPLOAD_BYTES)).toMatchObject({
      status: 413,
      code: "file_too_large",
    });

    const valid = new Request("https://app.example/api/media/upload", {
      method: "POST",
      headers: { origin: "https://app.example", "content-length": "1024" },
    });
    expect(validateUploadRequestHeaders(valid, MAX_UPLOAD_BYTES)).toBeUndefined();
  });
});

describe("Studio server-function errors", () => {
  test("preserves typed FNF and HTTP errors for the RPC serializer", () => {
    expect(
      isStructuredRequestError(
        new ApiJobError("project_not_found", "Missing project", { status: 404 }),
      ),
    ).toBeTrue();
    expect(isStructuredRequestError({ statusCode: 404 })).toBeTrue();
    expect(isStructuredRequestError(new Error("boom"))).toBeFalse();
  });
});
