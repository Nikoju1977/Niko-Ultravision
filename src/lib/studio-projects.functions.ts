import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  createStudioProject,
  deleteStudioProject,
  linkStudioGenerations,
  listStudioProjects,
  renameStudioProject,
} from "./studio-projects.server";

export interface StudioProjectRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  generationCount: number;
}

export interface StudioGenerationProjectLink {
  generationId: string;
  projectId: string;
}

export const listStudioProjectsFn = createServerFn({ method: "POST" }).handler(() =>
  listStudioProjects(),
);

export const createStudioProjectFn = createServerFn({ method: "POST" })
  .validator(z.object({ name: z.string().trim().min(1).max(80) }))
  .handler(({ data }) => createStudioProject(data.name));

export const renameStudioProjectFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      projectId: z.string().min(1),
      name: z.string().trim().min(1).max(80),
    }),
  )
  .handler(({ data }) => renameStudioProject(data.projectId, data.name));

export const deleteStudioProjectFn = createServerFn({ method: "POST" })
  .validator(z.object({ projectId: z.string().min(1) }))
  .handler(({ data }) => deleteStudioProject(data.projectId));

export const linkStudioGenerationsFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      projectId: z.string().min(1),
      generationIds: z.array(z.string().min(1)).min(1).max(32),
    }),
  )
  .handler(({ data }) => linkStudioGenerations(data.projectId, data.generationIds));
