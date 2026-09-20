import { describe, expect, test } from "bun:test";
import { ApiJobError } from "@higgsfield/fnf/errors";
import { linkProjectWithOneRetry } from "../src/lib/project-link-retry";

describe("Studio project link recovery", () => {
  test("retries one transient failure", async () => {
    let attempts = 0;
    const result = await linkProjectWithOneRetry(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary network failure");
      return "linked";
    });
    expect(result).toBe("linked");
    expect(attempts).toBe(2);
  });

  test("does not retry a rejected project request", async () => {
    let attempts = 0;
    const error = new ApiJobError("project_not_found", "Missing project", { status: 404 });
    await expect(
      linkProjectWithOneRetry(async () => {
        attempts += 1;
        throw error;
      }),
    ).rejects.toBe(error);
    expect(attempts).toBe(1);
  });
});
