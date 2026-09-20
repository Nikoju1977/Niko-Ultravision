import { describe, expect, test } from "bun:test";
import type { ListResult } from "@higgsfield/fnf/client";
import type { MediaListResult, MediaRef } from "@higgsfield/fnf/media";
import {
  flattenMediaPages,
  getNextStudioCursor,
  indexProjectItems,
} from "../src/lib/studio-history";

function page(cursor?: string | number): ListResult {
  return { items: [], ...(cursor !== undefined ? { cursor } : {}) };
}

describe("Studio history pagination", () => {
  test("continues with a new string or numeric cursor", () => {
    expect(getNextStudioCursor(page("next"), [page("next")])).toBe("next");
    expect(getNextStudioCursor(page(2), [page(1), page(2)])).toBe(2);
  });

  test("stops when the backend repeats a cursor", () => {
    expect(getNextStudioCursor(page("same"), [page("same"), page("same")])).toBeUndefined();
    expect(getNextStudioCursor(page(1), [page(1), page(1)])).toBeUndefined();
  });
});

describe("Studio media pagination", () => {
  test("flattens pages without duplicate refs", () => {
    const first = { id: "one", type: "media_input" } as MediaRef;
    const duplicate = { ...first, type: "newer_type" } as MediaRef;
    const second = { id: "two", type: "media_input" } as MediaRef;
    const mediaPage = (items: MediaRef[]): MediaListResult => ({ items });

    expect(
      flattenMediaPages({ pages: [mediaPage([first]), mediaPage([duplicate, second])] }),
    ).toEqual([duplicate, second]);
  });
});

test("indexes project items once while preserving feed order", () => {
  const first = { id: "first", projectId: "one" };
  const unassigned = { id: "unassigned" };
  const second = { id: "second", projectId: "one" };
  const other = { id: "other", projectId: "two" };

  expect(indexProjectItems([first, unassigned, second, other])).toEqual(
    new Map([
      ["one", [first, second]],
      ["two", [other]],
    ]),
  );
});
