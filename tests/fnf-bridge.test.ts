import { describe, expect, test } from "bun:test";
import { toJsonValue } from "../src/lib/fnf.functions";

describe("FNF RPC serialization", () => {
  test("keeps JSON values and removes undefined object fields", () => {
    expect(toJsonValue({ id: "job-1", count: 2, missing: undefined, flags: [true, null] })).toEqual(
      { id: "job-1", count: 2, flags: [true, null] },
    );
  });

  test("rejects values that cannot cross the server-function boundary", () => {
    expect(() => toJsonValue(() => undefined)).toThrow("non-serializable");
  });
});
