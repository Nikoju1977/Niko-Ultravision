import { ApiJobError } from "@higgsfield/fnf/errors";
import { inferContentType } from "@higgsfield/fnf/media";
import { createFileRoute } from "@tanstack/react-router";
import { createServerFnf } from "@/lib/fnf.server";
import { validateUploadRequestHeaders } from "@/lib/upload-request-security";

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export const Route = createFileRoute("/api/media/upload")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const rejection = validateUploadRequestHeaders(request, MAX_UPLOAD_BYTES);
          if (rejection != null) {
            return Response.json(
              { ok: false, error: { code: rejection.code, message: rejection.message } },
              { status: rejection.status },
            );
          }
          const form = await request.formData();
          const file = form.get("file");
          if (!(file instanceof File)) {
            return Response.json(
              { ok: false, error: { code: "invalid_file", message: "Choose an image to upload." } },
              { status: 400 },
            );
          }
          const contentType = inferContentType(file.name, file.type);
          if (!contentType.startsWith("image/")) {
            return Response.json(
              {
                ok: false,
                error: { code: "invalid_file_type", message: "Only image uploads are supported." },
              },
              { status: 415 },
            );
          }
          if (file.size > MAX_UPLOAD_BYTES) {
            return Response.json(
              {
                ok: false,
                error: { code: "file_too_large", message: "Images must be 20 MB or smaller." },
              },
              { status: 413 },
            );
          }

          const result = await createServerFnf().media.upload({
            source: new Uint8Array(await file.arrayBuffer()),
            type: "image",
            filename: file.name,
            contentType,
            forceIpCheck: true,
          });
          const url = result.url ?? result.ref.url;
          if (!url) {
            throw new ApiJobError("upload_missing_url", "Upload completed without a preview URL");
          }
          return Response.json({ ok: true, ref: result.ref, url });
        } catch (error) {
          const payload =
            error instanceof ApiJobError
              ? error.toJSON()
              : {
                  code: "upload_failed",
                  message: error instanceof Error ? error.message : String(error),
                };
          return Response.json({ ok: false, error: payload }, { status: payload.status ?? 500 });
        }
      },
    },
  },
});
