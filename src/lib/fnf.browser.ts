import { createProfileClient, type FnfAdapter } from "@higgsfield/fnf";
import type { MediaRef } from "@higgsfield/fnf/media";
import { errorFromJSON } from "@higgsfield/fnf/errors";
import { topazImageUpscale, topazVideoUpscale, higgsfieldVideoUpscale, bytedanceVideoUpscale } from "@higgsfield/fnf/jobs";
import type { AssetSelection } from "@/components/asset-library";
import {
  cancelJobFn,
  createJobsFn,
  estimateCostFn,
  getCurrentWorkspaceFn,
  getJobFn,
  getJobSetFn,
  getMediaFn,
  getUserFn,
  getWorkspaceWalletFn,
  listJobsFn,
  listMediaFn,
  listWorkspacesFn,
  switchWorkspaceFn,
} from "./fnf.functions";
import type { FnfRpcResult } from "./fnf.functions";
import { requestGenerationApproval } from "./generation-approval";

export const STUDIO_JOBS = [topazImageUpscale, topazVideoUpscale, higgsfieldVideoUpscale, bytedanceVideoUpscale] as const;

async function unwrap(result: FnfRpcResult): Promise<unknown> {
  if (!result.ok) throw errorFromJSON(result.error);
  return result.value;
}

/** Browser-safe adapter: every backend operation crosses a TanStack server function. */
export const fnfBrowserAdapter: FnfAdapter = {
  confirm: requestGenerationApproval,
  createJobs: (data) => createJobsFn({ data }).then(unwrap),
  getJob: (id) => getJobFn({ data: { id } }).then(unwrap),
  getJobSet: (id) => getJobSetFn({ data: { id } }).then(unwrap),
  listJobs: (data) => listJobsFn({ data }).then(unwrap),
  estimateCost: (data) => estimateCostFn({ data }).then(unwrap),
  cancelJob: (id) => cancelJobFn({ data: { id } }).then(unwrap),
  getMedia: (data) => getMediaFn({ data }).then(unwrap),
  listMedia: (data) => listMediaFn({ data }).then(unwrap),
  getUser: () => getUserFn().then(unwrap),
  listWorkspaces: () => listWorkspacesFn().then(unwrap),
  getCurrentWorkspace: () => getCurrentWorkspaceFn().then(unwrap),
  getWorkspaceWallet: () => getWorkspaceWalletFn().then(unwrap),
  switchWorkspace: (data) => switchWorkspaceFn({ data }).then(unwrap),
};

const profileClient = createProfileClient({ profileAdapter: fnfBrowserAdapter });

type CurrentUser = { id: string; workspaceId?: string | null };
export const GUEST_SCOPE_KEY = "guest";

export async function fetchCurrentUser(): Promise<CurrentUser | null> {
  try {
    const response = await fetch("/api/user", { credentials: "include" });
    if (response.status === 401 || !response.ok) return null;
    return (await response.json()) as CurrentUser;
  } catch {
    return null;
  }
}

/** Resolve the identity boundary used by every browser-side Studio cache. */
export async function getFnfScopeKey(): Promise<string> {
  const user = await fetchCurrentUser();
  if (user == null) return GUEST_SCOPE_KEY;
  const workspace = await profileClient.getCurrentWorkspace().catch(() => null);
  return `${user.id}:${workspace?.id ?? user.workspaceId ?? "personal"}`;
}

export function getSignInUrl(scopeKey: string, returnPath: string): string | null {
  if (scopeKey !== GUEST_SCOPE_KEY) return null;
  const safeReturnPath = returnPath.startsWith("/") && !returnPath.startsWith("//")
    ? returnPath
    : "/";
  return `/__auth/login?return=${encodeURIComponent(safeReturnPath)}`;
}

type UploadResponse =
  | { ok: true; ref: MediaRef; url: string }
  | { ok: false; error: { code: string; message: string; status?: number; data?: unknown } };

export async function uploadAsset(file: File): Promise<AssetSelection> {
  const form = new FormData();
  form.set("file", file);
  const response = await fetch("/api/media/upload", { method: "POST", body: form });
  const body = (await response.json()) as UploadResponse;
  if (!body.ok) throw errorFromJSON(body.error);
  return {
    name: file.name,
    type: file.type || body.ref.type,
    src: body.url,
    kind: file.type.startsWith("video/") ? "video" : "image",
    ref: { ...body.ref, type: "media_input" },
  };
}
