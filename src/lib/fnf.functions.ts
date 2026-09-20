import type { FnfAdapter } from "@higgsfield/fnf";
import { ApiJobError } from "@higgsfield/fnf/errors";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createServerFnf } from "./fnf.server";

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type FnfRpcResult =
  | { ok: true; value: JsonValue }
  | {
      ok: false;
      error: { code: string; message: string; status?: number; data?: JsonValue };
    };

export function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === "object") {
    const result: { [key: string]: JsonValue } = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) result[key] = toJsonValue(entry);
    }
    return result;
  }
  throw new Error("FNF returned a non-serializable response");
}

async function call(operation: (adapter: FnfAdapter) => Promise<unknown>): Promise<FnfRpcResult> {
  try {
    return { ok: true, value: toJsonValue(await operation(createServerFnf().adapter)) };
  } catch (error) {
    const data =
      error instanceof ApiJobError && error.data !== undefined
        ? toJsonValue(error.data)
        : undefined;
    return {
      ok: false,
      error:
        error instanceof ApiJobError
          ? {
              code: error.code,
              message: error.message,
              ...(error.status !== undefined ? { status: error.status } : {}),
              ...(data !== undefined ? { data } : {}),
            }
          : { code: "unexpected", message: error instanceof Error ? error.message : String(error) },
    };
  }
}

const idInput = z.object({ id: z.string().min(1) });
const stringOrStrings = z.union([z.string(), z.array(z.string())]);

export const createJobsFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      jobSetType: z.string().min(1),
      params: z.record(z.string(), z.unknown()),
      confirmationToken: z.string().optional(),
    }),
  )
  .handler(({ data }) => call((adapter) => adapter.createJobs(data)));

export const getJobFn = createServerFn({ method: "POST" })
  .validator(idInput)
  .handler(({ data }) => call((adapter) => adapter.getJob(data.id)));

export const getJobSetFn = createServerFn({ method: "POST" })
  .validator(idInput)
  .handler(({ data }) => call((adapter) => adapter.getJobSet!(data.id)));

export const listJobsFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      type: z.enum(["image", "video"]).optional(),
      cursor: z.union([z.string(), z.number()]).optional(),
      size: z.number().int().positive().max(100).optional(),
      parentId: z.string().optional(),
      status: stringOrStrings.optional(),
      model: stringOrStrings.optional(),
    }),
  )
  .handler(({ data }) => call((adapter) => adapter.listJobs(data)));

export const estimateCostFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      jobSetType: z.string().min(1),
      params: z.record(z.string(), z.unknown()),
    }),
  )
  .handler(({ data }) => call((adapter) => adapter.estimateCost(data)));

export const cancelJobFn = createServerFn({ method: "POST" })
  .validator(idInput)
  .handler(({ data }) => call((adapter) => adapter.cancelJob!(data.id)));

const mediaType = z.enum(["image", "video", "audio"]);

export const getMediaFn = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.string().min(1), type: mediaType }))
  .handler(({ data }) => call((adapter) => adapter.getMedia(data)));

export const listMediaFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      type: mediaType,
      cursor: z.union([z.string(), z.number()]).optional(),
      size: z.number().int().positive().max(100).optional(),
    }),
  )
  .handler(({ data }) => call((adapter) => adapter.listMedia(data)));

export const getUserFn = createServerFn({ method: "POST" }).handler(() =>
  call((adapter) => adapter.getUser()),
);

export const listWorkspacesFn = createServerFn({ method: "POST" }).handler(() =>
  call((adapter) => adapter.listWorkspaces()),
);

export const getCurrentWorkspaceFn = createServerFn({ method: "POST" }).handler(() =>
  call((adapter) => adapter.getCurrentWorkspace()),
);

export const getWorkspaceWalletFn = createServerFn({ method: "POST" }).handler(() =>
  call((adapter) => adapter.getWorkspaceWallet()),
);

export const switchWorkspaceFn = createServerFn({ method: "POST" })
  .validator(z.object({ workspaceId: z.string().min(1) }))
  .handler(({ data }) => call((adapter) => adapter.switchWorkspace(data)));
