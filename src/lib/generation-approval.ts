import type { ConfirmSubmit, ConfirmSubmitRequest } from "@higgsfield/fnf";
import { ApiJobError, ConfirmationRejectedError } from "@higgsfield/fnf/errors";

interface GenerationApprovalPlatform {
  requestGeneration(model: string, params: Record<string, unknown>): Promise<string>;
}

declare global {
  interface Window {
    hf?: GenerationApprovalPlatform;
  }
}

/**
 * Ask the Higgsfield host to approve the exact request FNF is about to submit.
 * The host owns the security modal; templates must not add a second browser dialog.
 */
export const requestGenerationApproval: ConfirmSubmit = (request) =>
  requestGenerationApprovalWith(request, typeof window === "undefined" ? undefined : window.hf);

export async function requestGenerationApprovalWith(
  { jobSetType, params }: ConfirmSubmitRequest,
  platform?: GenerationApprovalPlatform,
): Promise<string> {
  if (!platform?.requestGeneration) {
    throw new ApiJobError(
      "approval_unavailable",
      "Higgsfield generation approval is unavailable. Open this app through Higgsfield and try again.",
    );
  }

  try {
    return await platform.requestGeneration(jobSetType, params);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ConfirmationRejectedError();
    }
    if (error instanceof ApiJobError) throw error;
    throw new ApiJobError(
      "approval_unavailable",
      error instanceof Error ? error.message : "Higgsfield generation approval failed.",
    );
  }
}
