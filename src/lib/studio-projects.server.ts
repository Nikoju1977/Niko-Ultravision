import { ApiJobError } from "@higgsfield/fnf/errors";
import type { D1Database } from "@cloudflare/workers-types";
import { createServerFnf } from "./fnf.server";
import type { StudioGenerationProjectLink, StudioProjectRecord } from "./studio-projects.functions";

interface ProjectRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  generation_count?: number;
}

interface LinkRow {
  generation_id: string;
  project_id: string;
}

interface DevProjectRow extends ProjectRow {
  owner_key: string;
}

interface DevLinkRow extends LinkRow {
  owner_key: string;
}

interface DevProjectState {
  projects: DevProjectRow[];
  links: DevLinkRow[];
}

const devGlobal = globalThis as typeof globalThis & {
  __studioProjectState?: DevProjectState;
};

function developmentState(): DevProjectState {
  return (devGlobal.__studioProjectState ??= { projects: [], links: [] });
}

/**
 * Vite dev runs in Node and cannot resolve the Workers-only env module. The
 * deployed Worker always takes the D1 branch; only local development falls
 * back to process-memory data so the complete project UX remains testable.
 */
async function database(): Promise<D1Database | null> {
  try {
    const { bindings } = await import("./bindings.server");
    const db = bindings().DB;
    if (db) return db;
  } catch (error) {
    if (!import.meta.env.DEV) throw error;
  }
  if (import.meta.env.DEV) return null;
  throw new ApiJobError(
    "studio_database_unavailable",
    "Studio projects are unavailable because the app database is not configured.",
    { status: 503 },
  );
}

async function ownerKey(): Promise<string> {
  try {
    const profile = createServerFnf().profile;
    const user = await profile.getUser();
    if (!user) {
      throw new ApiJobError("authentication_required", "Sign in to use Studio projects.", {
        status: 401,
      });
    }
    const workspace = await profile.getCurrentWorkspace().catch(() => null);
    return `user:${user.id}:workspace:${workspace?.id ?? user.workspaceId ?? "personal"}`;
  } catch (error) {
    if (import.meta.env.DEV) return "development:local";
    throw error;
  }
}

function mapProject(row: ProjectRow): StudioProjectRecord {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    generationCount: Number(row.generation_count ?? 0),
  };
}

export async function listStudioProjects(): Promise<{
  projects: StudioProjectRecord[];
  links: StudioGenerationProjectLink[];
}> {
  const owner = await ownerKey();
  const db = await database();
  if (!db) {
    const state = developmentState();
    return {
      projects: state.projects
        .filter((project) => project.owner_key === owner)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .map((project) => ({
          ...project,
          generation_count: state.links.filter(
            (link) => link.owner_key === owner && link.project_id === project.id,
          ).length,
        }))
        .map(mapProject),
      links: state.links
        .filter((link) => link.owner_key === owner)
        .map((link) => ({ generationId: link.generation_id, projectId: link.project_id })),
    };
  }
  const [projectResult, linkResult] = await Promise.all([
    db
      .prepare(
        "SELECT p.id, p.name, p.created_at, p.updated_at, COUNT(l.generation_id) AS generation_count FROM studio_projects p LEFT JOIN studio_generation_projects l ON l.owner_key = p.owner_key AND l.project_id = p.id WHERE p.owner_key = ? GROUP BY p.id, p.name, p.created_at, p.updated_at ORDER BY p.updated_at DESC, p.created_at DESC",
      )
      .bind(owner)
      .all<ProjectRow>(),
    db
      .prepare(
        "SELECT generation_id, project_id FROM studio_generation_projects WHERE owner_key = ?",
      )
      .bind(owner)
      .all<LinkRow>(),
  ]);

  return {
    projects: projectResult.results.map(mapProject),
    links: linkResult.results.map((row) => ({
      generationId: row.generation_id,
      projectId: row.project_id,
    })),
  };
}

export async function createStudioProject(name: string): Promise<StudioProjectRecord> {
  const owner = await ownerKey();
  const db = await database();
  const id = crypto.randomUUID();
  if (!db) {
    const now = new Date().toISOString();
    const row: DevProjectRow = {
      id,
      owner_key: owner,
      name,
      created_at: now,
      updated_at: now,
    };
    developmentState().projects.push(row);
    return mapProject(row);
  }
  await db
    .prepare("INSERT INTO studio_projects (id, owner_key, name) VALUES (?, ?, ?)")
    .bind(id, owner, name)
    .run();
  const row = await db
    .prepare(
      "SELECT id, name, created_at, updated_at FROM studio_projects WHERE id = ? AND owner_key = ?",
    )
    .bind(id, owner)
    .first<ProjectRow>();
  if (!row) throw new ApiJobError("project_create_failed", "The project could not be created.");
  return mapProject(row);
}

export async function renameStudioProject(
  projectId: string,
  name: string,
): Promise<StudioProjectRecord> {
  const owner = await ownerKey();
  const db = await database();
  if (!db) {
    const project = developmentState().projects.find(
      (candidate) => candidate.id === projectId && candidate.owner_key === owner,
    );
    if (!project) {
      throw new ApiJobError("project_not_found", "The selected project no longer exists.", {
        status: 404,
      });
    }
    project.name = name;
    project.updated_at = new Date().toISOString();
    return mapProject(project);
  }

  const existing = await db
    .prepare("SELECT id FROM studio_projects WHERE id = ? AND owner_key = ?")
    .bind(projectId, owner)
    .first<{ id: string }>();
  if (!existing) {
    throw new ApiJobError("project_not_found", "The selected project no longer exists.", {
      status: 404,
    });
  }
  await db
    .prepare(
      "UPDATE studio_projects SET name = ?, updated_at = datetime('now') WHERE id = ? AND owner_key = ?",
    )
    .bind(name, projectId, owner)
    .run();
  const row = await db
    .prepare(
      "SELECT id, name, created_at, updated_at FROM studio_projects WHERE id = ? AND owner_key = ?",
    )
    .bind(projectId, owner)
    .first<ProjectRow>();
  if (!row) throw new ApiJobError("project_rename_failed", "The project could not be renamed.");
  return mapProject(row);
}

export async function deleteStudioProject(projectId: string): Promise<{ id: string }> {
  const owner = await ownerKey();
  const db = await database();
  if (!db) {
    const state = developmentState();
    const index = state.projects.findIndex(
      (candidate) => candidate.id === projectId && candidate.owner_key === owner,
    );
    if (index < 0) {
      throw new ApiJobError("project_not_found", "The selected project no longer exists.", {
        status: 404,
      });
    }
    state.projects.splice(index, 1);
    state.links = state.links.filter(
      (link) => !(link.owner_key === owner && link.project_id === projectId),
    );
    return { id: projectId };
  }

  const existing = await db
    .prepare("SELECT id FROM studio_projects WHERE id = ? AND owner_key = ?")
    .bind(projectId, owner)
    .first<{ id: string }>();
  if (!existing) {
    throw new ApiJobError("project_not_found", "The selected project no longer exists.", {
      status: 404,
    });
  }
  await db.batch([
    db
      .prepare("DELETE FROM studio_generation_projects WHERE owner_key = ? AND project_id = ?")
      .bind(owner, projectId),
    db.prepare("DELETE FROM studio_projects WHERE id = ? AND owner_key = ?").bind(projectId, owner),
  ]);
  return { id: projectId };
}

export async function linkStudioGenerations(
  projectId: string,
  generationIds: string[],
): Promise<StudioGenerationProjectLink[]> {
  const owner = await ownerKey();
  const db = await database();
  if (!db) {
    const state = developmentState();
    const project = state.projects.find(
      (candidate) => candidate.id === projectId && candidate.owner_key === owner,
    );
    if (!project) {
      throw new ApiJobError("project_not_found", "The selected project no longer exists.", {
        status: 404,
      });
    }
    for (const generationId of generationIds) {
      const existing = state.links.find(
        (link) => link.owner_key === owner && link.generation_id === generationId,
      );
      if (existing) existing.project_id = projectId;
      else
        state.links.push({ owner_key: owner, generation_id: generationId, project_id: projectId });
    }
    project.updated_at = new Date().toISOString();
    return generationIds.map((generationId) => ({ generationId, projectId }));
  }
  const project = await db
    .prepare("SELECT id FROM studio_projects WHERE id = ? AND owner_key = ?")
    .bind(projectId, owner)
    .first<{ id: string }>();
  if (!project) {
    throw new ApiJobError("project_not_found", "The selected project no longer exists.", {
      status: 404,
    });
  }

  await db.batch([
    ...generationIds.map((generationId) =>
      db
        .prepare(
          "INSERT INTO studio_generation_projects (owner_key, generation_id, project_id) VALUES (?, ?, ?) ON CONFLICT(owner_key, generation_id) DO UPDATE SET project_id = excluded.project_id",
        )
        .bind(owner, generationId, projectId),
    ),
    db
      .prepare(
        "UPDATE studio_projects SET updated_at = datetime('now') WHERE id = ? AND owner_key = ?",
      )
      .bind(projectId, owner),
  ]);

  return generationIds.map((generationId) => ({ generationId, projectId }));
}
