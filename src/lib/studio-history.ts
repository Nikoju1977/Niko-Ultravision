import type { ListResult } from "@higgsfield/fnf/client";
import type { MediaListResult, MediaRef } from "@higgsfield/fnf/media";

/** Stop malformed backends from turning one repeated cursor into an endless loop. */
export function getNextCursor<T extends { cursor?: string | number }>(
  lastPage: T,
  allPages: readonly T[],
): string | number | undefined {
  const cursor = lastPage.cursor;
  if (cursor === undefined) return undefined;
  return allPages.slice(0, -1).some((page) => page.cursor === cursor) ? undefined : cursor;
}

/** Stop malformed backends from turning one repeated cursor into an endless loop. */
export function getNextStudioCursor(
  lastPage: ListResult,
  allPages: ListResult[],
): string | number | undefined {
  return getNextCursor(lastPage, allPages);
}

/** Flatten pages: keep each ref's first position and its latest fetched value. */
export function flattenMediaPages(data: { pages: readonly MediaListResult[] }): MediaRef[] {
  const refs = new Map<string, MediaRef>();
  for (const page of data.pages) {
    for (const ref of page.items) {
      refs.set(ref.id, ref);
    }
  }
  return [...refs.values()];
}

/** Index project-owned rows once so every project view can reuse the same arrays. */
export function indexProjectItems<T extends { projectId?: string }>(
  items: readonly T[],
): Map<string, T[]> {
  const projects = new Map<string, T[]>();
  for (const item of items) {
    if (item.projectId == null) continue;
    const project = projects.get(item.projectId);
    if (project) project.push(item);
    else projects.set(item.projectId, [item]);
  }
  return projects;
}
