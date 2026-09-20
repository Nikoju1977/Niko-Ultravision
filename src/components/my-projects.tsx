import { useMemo } from "react";
import { Plus as IconPlusOutlined } from "lucide-react";
import { Icon } from "@higgsfield/quanta/icon";
import { Typography } from "@higgsfield/quanta/typography";
import type { GalleryItem } from "@/components/gallery";
import { ProjectCreateModal } from "@/components/project-create-modal";
import { cn as cx } from "@/lib/utils";

export interface MyProjectsProject {
  id: string;
  name: string;
  generationCount: number;
  cover?: string;
  updatedAt?: string;
}

export interface MyProjectsProps {
  projects: MyProjectsProject[];
  generations: GalleryItem[];
  onCreateProject: (name: string) => void | Promise<void>;
  onOpenAllGenerations: () => void;
  onOpenProject: (project: MyProjectsProject) => void;
  className?: string;
}

function generationTimestamp(item: GalleryItem): number {
  if (typeof item.createdAt === "number") {
    return item.createdAt > 10_000_000_000 ? item.createdAt : item.createdAt * 1000;
  }
  if (typeof item.createdAt === "string") {
    const timestamp = Date.parse(item.createdAt);
    return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
  }
  return Number.NEGATIVE_INFINITY;
}

function previewImages(
  project: MyProjectsProject | undefined,
  matching: readonly string[],
): Array<string | undefined> {
  return Array.from(
    { length: 5 },
    (_, index) => matching[index] ?? (index === 0 ? project?.cover : undefined),
  );
}

function Preview({ src, className }: { src?: string; className: string }) {
  return src ? (
    <img src={src} alt="" className={className} />
  ) : (
    <div aria-hidden className={`${className} bg-q-background-secondary-strong`} />
  );
}

function ProjectPreviewMosaic({ images }: { images: Array<string | undefined> }) {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_80px_80px] gap-3">
      <Preview src={images[0]} className="size-full min-h-0 rounded-q-200 object-cover" />
      {[1, 3].map((start) => (
        <div key={start} className="grid min-h-0 grid-rows-2 gap-3">
          <Preview src={images[start]} className="size-full min-h-0 rounded-q-200 object-cover" />
          <Preview
            src={images[start + 1]}
            className="size-full min-h-0 rounded-q-200 object-cover"
          />
        </div>
      ))}
    </div>
  );
}

export interface ProjectCardProps {
  title: string;
  subtitle: string;
  images: Array<string | undefined>;
  onOpen: () => void;
}

export function ProjectCard({ title, subtitle, images, onOpen }: ProjectCardProps) {
  return (
    <article className="motion-card relative flex h-[248px] min-w-0 flex-col gap-3 overflow-hidden rounded-q-500 border border-q-border-default bg-q-background-secondary p-3 shadow-q-raised">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1 px-1">
          <Typography as="h3" variant="label-sm-semi-bold" className="truncate">
            {title}
          </Typography>
          <Typography as="p" variant="caption-sm-medium" color="tertiary" className="truncate">
            {subtitle}
          </Typography>
        </div>
      </div>
      <ProjectPreviewMosaic images={images} />
      <button
        type="button"
        aria-label={`Open ${title}`}
        className="absolute inset-0 z-[1] cursor-pointer rounded-q-500 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-q-border-focus"
        onClick={onOpen}
      />
    </article>
  );
}

/**
 * My Projects — reusable project overview from Cinema Studio V4
 * (Figma node 14274:34631).
 */
export function MyProjects({
  projects,
  generations,
  onCreateProject,
  onOpenAllGenerations,
  onOpenProject,
  className,
}: MyProjectsProps) {
  const previews = useMemo(() => {
    const ordered = generations
      .filter((item) => item.status === "ready" && item.src !== "")
      .sort((a, b) => generationTimestamp(b) - generationTimestamp(a));
    const byProject = new Map<string, string[]>();
    for (const item of ordered) {
      if (item.projectId == null) continue;
      const project = byProject.get(item.projectId) ?? [];
      if (project.length < 5) project.push(item.src);
      byProject.set(item.projectId, project);
    }
    return {
      all: ordered.slice(0, 5).map((item) => item.src),
      byProject,
    };
  }, [generations]);

  return (
    <div
      className={cx(
        "grid w-full grid-cols-[repeat(auto-fit,minmax(min(100%,320px),1fr))] gap-6",
        className,
      )}
    >
      <ProjectCreateModal
        onCreate={onCreateProject}
        trigger={
          <button
            type="button"
            className="motion-card flex h-[248px] flex-col items-center justify-center gap-3 rounded-q-500 border border-q-border-default bg-q-background-secondary p-2 shadow-q-raised hover:bg-q-background-secondary-strong focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-q-border-focus"
          >
            <span className="flex size-10 items-center justify-center rounded-q-full border border-q-border-subtle bg-q-transparent-light-05 text-q-icon-primary shadow-q-raised">
              <Icon as={IconPlusOutlined} size="md" />
            </span>
            <Typography as="span" variant="label-sm-semi-bold">
              New project
            </Typography>
          </button>
        }
      />

      <ProjectCard
        title="All Generations"
        subtitle={`${generations.length.toLocaleString("en-US")} generations`}
        images={previewImages(undefined, previews.all)}
        onOpen={onOpenAllGenerations}
      />

      {projects.map((project) => (
        <ProjectCard
          key={project.id}
          title={project.name}
          subtitle={`${project.generationCount.toLocaleString("en-US")} generations  •  Private`}
          images={previewImages(project, previews.byProject.get(project.id) ?? [])}
          onOpen={() => onOpenProject(project)}
        />
      ))}
    </div>
  );
}
