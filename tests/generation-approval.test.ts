import { describe, expect, it } from "bun:test";
import { requestGenerationApprovalWith } from "../src/lib/generation-approval";

const request = {
  jobSetType: "seedance_2_0",
  params: { prompt: "Move slowly", duration: 5 },
};

describe("generation approval", () => {
  it("forwards the exact FNF request and returns the host token", async () => {
    const calls: unknown[][] = [];
    const token = await requestGenerationApprovalWith(request, {
      requestGeneration: async (...args) => {
        calls.push(args);
        return "intent-token";
      },
    });

    expect(token).toBe("intent-token");
    expect(calls).toEqual([[request.jobSetType, request.params]]);
  });

  it("fails visibly when the host approval SDK is unavailable", async () => {
    await expect(requestGenerationApprovalWith(request)).rejects.toMatchObject({
      code: "approval_unavailable",
    });
  });

  it("maps a dismissed host modal to a quiet confirmation rejection", async () => {
    await expect(
      requestGenerationApprovalWith(request, {
        requestGeneration: async () => {
          throw new DOMException("Cancelled", "AbortError");
        },
      }),
    ).rejects.toMatchObject({ code: "confirmation_rejected" });
  });

  it("keeps non-cancellation host failures visible", async () => {
    await expect(
      requestGenerationApprovalWith(request, {
        requestGeneration: async () => {
          throw new Error("Approval service unavailable");
        },
      }),
    ).rejects.toMatchObject({
      code: "approval_unavailable",
      message: "Approval service unavailable",
    });
  });
});
