import { ApiJobError } from "@higgsfield/fnf/errors";

/** Errors with an HTTP/RPC contract must reach TanStack Start's serializer intact. */
export function isStructuredRequestError(error: unknown): boolean {
  if (ApiJobError.is(error)) return true;
  if (error == null || typeof error !== "object") return false;
  return "statusCode" in error || ("status" in error && "code" in error);
}
