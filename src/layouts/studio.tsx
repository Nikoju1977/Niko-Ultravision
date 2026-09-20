import type { ComponentProps, CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SubmitInputFor } from "@higgsfield/fnf/client";
import {
  costQueryOptions,
  flattenFeedPages,
  jobsFeedQueryOptions,
  prependGenerations,
  useFnfJobClient,
  useFnfMediaClient,
  useFnfScopeKey,
  useGenerationRun,
  useLiveFeedGenerations,
} from "@higgsfield/fnf-react";
import { Image as IconImageOutlined, Film as IconFilmOutlined, ShieldCheck as IconShieldOutlined, SlidersHorizontal as IconTuneOutlined } from "lucide-react";
import { Compass as IconExploreOutlined } from "lucide-react";
import { Folder as IconProjectsOutlined } from "lucide-react";
import { Plus as IconPlusMediumOutlined } from "lucide-react";
import {
  PanelLeftClose as IconSidebarHiddenLeftWideOutlined,
  PanelLeftOpen as IconSidebarVisibleLeftWideOutlined,
} from "lucide-react";
import { House as IconHomeFilled, Images as IconImagesFilled } from "@phosphor-icons/react";
import { Icon } from "@higgsfield/quanta/icon";
import { Button } from "@higgsfield/quanta/button";
import { Loader } from "@higgsfield/quanta/loader";
import { Modal } from "@higgsfield/quanta/modal";
import { Sidebar } from "@higgsfield/quanta/sidebar";
import { Tabs } from "@higgsfield/quanta/tabs";
import { Typography } from "@higgsfield/quanta/typography";
import type {
  AssetLibraryItem,
  AssetLibraryPagination,
  AssetSelection,
} from "@/components/asset-library";
import type { GalleryItem } from "@/components/gallery";
import { HeroComposition } from "@/components/hero-composition";
import { IconTile } from "@/components/icon-tile";
import { MyProjects } from "@/components/my-projects";
import type { MyProjectsProject } from "@/components/my-projects";
import { ProjectActions } from "@/components/project-actions";
import { ProjectCreateModal } from "@/components/project-create-modal";
import { SignInModal } from "@/components/sign-in-modal";
import { StudioPromptBox } from "@/components/studio-prompt-box";
import type {
  PromptModeOption,
  PromptSettingOption,
  PromptUploadOption,
} from "@/components/studio-prompt-box";
import { UserGenerations } from "@/components/user-generations";
import { appFaviconUrl, appMeta } from "@/lib/app-meta";
import { cn } from "@/lib/utils";
import { getSignInUrl, STUDIO_JOBS, uploadAsset } from "@/lib/fnf.browser";
import {
  generationToAssetItem,
  generationToGalleryItem,
  getGenerationFailureLabel,
  getGenerationStatusLabel,
  mediaRefToAssetItem,
  selectGenerationMedia,
} from "@/lib/higgsfield-generation-results";
import {
  flattenMediaPages,
  getNextCursor,
  getNextStudioCursor,
  indexProjectItems,
} from "@/lib/studio-history";
import { linkProjectWithOneRetry } from "@/lib/project-link-retry";
import {
  createStudioProjectFn,
  deleteStudioProjectFn,
  linkStudioGenerationsFn,
  listStudioProjectsFn,
  renameStudioProjectFn,
} from "@/lib/studio-projects.functions";

/**
 * Production-ready Studio scaffold: one FNF-backed prompt state is shared by
 * the home and history docks; uploads are durable; history is cursor-paged and
 * virtualized; app projects and generation links are scoped/persisted in D1.
 * Keep the four Studio pillars when adapting: sidebar, hero, prompt dock, feed.
 */

type StudioGenerationInput = SubmitInputFor<typeof STUDIO_JOBS>;
type StudioProject = MyProjectsProject;
type StudioDockProps = Omit<ComponentProps<typeof StudioPromptBox>, "className" | "surface">;
type StudioView = { kind: "home" } | { kind: "all" } | { kind: "project"; projectId: string };

const HISTORY_QUERY = { type: "video" as const, size: 40 };
const IMAGE_LIBRARY_QUERY = { type: "image" as const, size: 40 };

const IMAGE_TARGETS = [
  { value: "original", title: "Original", subtitle: "Restore without resizing" },
  { value: "2k", title: "2K", subtitle: "Preserve original ratio" },
  { value: "4k", title: "4K", subtitle: "Professional delivery" },
  { value: "8k", title: "8K", subtitle: "High-resolution master" },
  { value: "16k", title: "16K", subtitle: "Large-format master" },
  { value: "32k", title: "32K", subtitle: "Ultra Master · source dependent" },
];

const VIDEO_TARGETS = [
  { value: "original", title: "Original", subtitle: "Restore without resizing" },
  { value: "1080p", title: "1080p", subtitle: "Full HD master" },
  { value: "2k", title: "2K", subtitle: "Cinema intermediate" },
  { value: "4k", title: "4K", subtitle: "Production master" },
  { value: "8k", title: "8K Experimental", subtitle: "Backend capability dependent" },
  { value: "16k", title: "16K Experimental", subtitle: "Backend capability dependent" },
];

const PROFILES = [
  { value: "fidelity", title: "Fidelity Pro", subtitle: "Maximum faithfulness, minimum invention" },
  { value: "archive", title: "Archive", subtitle: "Conservative restoration" },
  { value: "cinema", title: "Cinema Restore", subtitle: "Film texture and controlled detail" },
  { value: "detail", title: "Ultra Detail", subtitle: "Stronger recovery for difficult sources" },
];

const PROMPT_MODES: PromptModeOption[] = [
  { id: "image", label: "Image", icon: IconImageOutlined },
  { id: "video", label: "Video", icon: IconFilmOutlined },
];

const makePromptSettings = (targets: typeof IMAGE_TARGETS): PromptSettingOption[] => [
  {
    id: "target",
    start: <Icon as={IconTuneOutlined} size="sm" />,
    defaultValue: "4k",
    options: targets,
  },
  {
    id: "profile",
    start: <Icon as={IconShieldOutlined} size="sm" />,
    defaultValue: "fidelity",
    options: PROFILES,
  },
];

const IMAGE_PROMPT_SETTINGS = makePromptSettings(IMAGE_TARGETS);
const VIDEO_PROMPT_SETTINGS = makePromptSettings(VIDEO_TARGETS as typeof IMAGE_TARGETS);

const PROMPT_UPLOADS: Array<Pick<PromptUploadOption, "id" | "label">> = [
  { id: "source", label: "Source" },
];

const TARGET_LONG_SIDE: Record<string, number | undefined> = {
  original: undefined,
  "1080p": 1920,
  "2k": 2048,
  "4k": 3840,
  "8k": 7680,
  "16k": 15360,
  "32k": 30720,
};

function lockedOutputSize(selection: AssetSelection | undefined, target: string) {
  const width = selection?.ref?.meta?.width;
  const height = selection?.ref?.meta?.height;
  if (!width || !height) return null;
  const targetLong = TARGET_LONG_SIDE[target];
  if (targetLong == null) return { width, height };
  const scale = targetLong / Math.max(width, height);
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  return { width: even(width * scale), height: even(height * scale) };
}

const GALLERY_TABS = [
  { value: "explore", label: "Workflow", start: <Icon size="sm" as={IconExploreOutlined} /> },
  {
    value: "projects",
    label: "My Projects",
    start: <Icon size="sm" as={IconProjectsOutlined} />,
  },
];

const HERO_GLOW =
  "radial-gradient(60% 80% at 50% 0%, rgba(160,164,170,0.14) 0%, rgba(160,164,170,0.05) 42%, transparent 72%)";
const HERO_DOTS = "radial-gradient(rgba(255,255,255,0.2) 1px, transparent 1px)";
const HERO_DOTS_MASK =
  "radial-gradient(55% 70% at 50% 0%, #000 0%, rgba(0,0,0,0.35) 45%, transparent 75%)";

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

function latestProjectCover(
  project: StudioProject,
  generations: GalleryItem[],
): string | undefined {
  const matching = generations.filter((item) => item.status === "ready" && item.src !== "");
  if (matching.length === 0) return project.cover;
  return matching.reduce((latest, item) =>
    generationTimestamp(item) > generationTimestamp(latest) ? item : latest,
  ).src;
}

function useRequiredFnfScopeKey(): string {
  const scopeKey = useFnfScopeKey();
  if (scopeKey == null) throw new Error("Studio requires a user/workspace cache scope.");
  return scopeKey;
}

function StudioSidebar({
  view,
  onViewChange,
  projects,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  onClose,
}: {
  view: StudioView;
  onViewChange: (view: StudioView) => void;
  projects: StudioProject[];
  onCreateProject: (name: string) => Promise<void>;
  onRenameProject: (projectId: string, name: string) => Promise<void>;
  onDeleteProject: (projectId: string) => Promise<void>;
  onClose?: () => void;
}) {
  const title = appMeta.og_title?.trim() || "Studio";
  const handleNavigation = (nextView: StudioView) => {
    onViewChange(nextView);
    onClose?.();
  };

  return (
    <Sidebar.Root
      product="marketing-studio"
      flush={onClose != null}
      className={cn(onClose == null ? "m-2.5" : "m-0 !w-full")}
      style={
        {
          height: onClose == null ? "calc(100% - 20px)" : "100%",
          ["--q-sidebar-radius" as string]: onClose == null ? "12px" : "0px",
        } as CSSProperties
      }
    >
      <Sidebar.Header>
        <Sidebar.Switcher>
          <Sidebar.Logo>
            <span className="relative flex size-6 items-center justify-center overflow-hidden rounded-q-200 bg-q-brand-primary text-q-text-inverse">
              <span className="studio-sidebar-logo-mark flex size-full items-center justify-center">
                {appFaviconUrl != null ? (
                  <img src={appFaviconUrl} alt="" className="size-full object-cover" />
                ) : (
                  <span aria-hidden className="text-q-caption-xs-bold">
                    {title.slice(0, 1).toUpperCase()}
                  </span>
                )}
              </span>
              <span
                aria-hidden
                className="studio-sidebar-expand-icon pointer-events-none absolute inset-0 flex items-center justify-center"
              >
                <Icon as={IconSidebarVisibleLeftWideOutlined} size="md" />
              </span>
            </span>
          </Sidebar.Logo>
          <Sidebar.Title>{title}</Sidebar.Title>
        </Sidebar.Switcher>
        <Sidebar.Toggle
          aria-label={onClose != null ? "Close navigation" : undefined}
          onClick={
            onClose != null
              ? (event) => {
                  event.preventDefault();
                  onClose();
                }
              : undefined
          }
        >
          <Icon as={IconSidebarHiddenLeftWideOutlined} size="md" />
        </Sidebar.Toggle>
      </Sidebar.Header>

      <Sidebar.Body>
        <Sidebar.Section>
          <Sidebar.SectionItems>
            <Sidebar.Item
              selected={view.kind === "home"}
              onClick={() => handleNavigation({ kind: "home" })}
              start={<IconTile as={IconHomeFilled} gradient="blue" />}
              title="Home"
            />
            <Sidebar.Item
              selected={view.kind === "all"}
              onClick={() => handleNavigation({ kind: "all" })}
              start={<IconTile as={IconImagesFilled} gradient="purple" />}
              title="All Generations"
            />
          </Sidebar.SectionItems>
        </Sidebar.Section>

        <Sidebar.Section>
          <Sidebar.SectionHeader>
            <Sidebar.SectionTitle>Projects</Sidebar.SectionTitle>
            <Sidebar.SectionActions>
              <ProjectCreateModal
                onCreate={onCreateProject}
                trigger={
                  <Sidebar.ActionButton aria-label="New project">
                    <Icon as={IconPlusMediumOutlined} size="md" />
                  </Sidebar.ActionButton>
                }
              />
            </Sidebar.SectionActions>
          </Sidebar.SectionHeader>
          <Sidebar.SectionItems>
            {projects.length === 0 ? (
              <ProjectCreateModal
                onCreate={onCreateProject}
                trigger={
                  <Sidebar.Item
                    variant="project"
                    start={
                      <span className="relative flex size-6 items-center justify-center overflow-hidden rounded-q-200 border border-[rgba(197,197,197,0.3)] bg-[rgba(255,255,255,0.04)] text-q-icon-secondary shadow-[0_5px_6px_rgba(0,0,0,0.1),inset_0_-0.3px_5px_rgba(185,185,185,0.35)] backdrop-blur-[3.7px]">
                        <Icon as={IconPlusMediumOutlined} size="sm" />
                      </span>
                    }
                    title={
                      <span className="text-q-label-sm-medium text-q-text-secondary">
                        Add project
                      </span>
                    }
                  />
                }
              />
            ) : (
              projects.map((project) => {
                return (
                  <Sidebar.Item
                    key={project.id}
                    variant="project"
                    selected={view.kind === "project" && view.projectId === project.id}
                    onClick={() =>
                      handleNavigation({ kind: "project", projectId: project.id })
                    }
                    start={
                      <Sidebar.ProjectThumbnail
                        src={project.cover}
                        alt={project.cover ? `Latest generation in ${project.name}` : ""}
                        fallback={project.name.slice(0, 1).toUpperCase()}
                      />
                    }
                    title={project.name}
                    meta={project.generationCount.toLocaleString("en-US")}
                    action={
                      <ProjectActions
                        projectName={project.name}
                        onRename={(name) => onRenameProject(project.id, name)}
                        onDelete={() => onDeleteProject(project.id)}
                      />
                    }
                    actionVisibility="hover"
                  />
                );
              })
            )}
          </Sidebar.SectionItems>
        </Sidebar.Section>
      </Sidebar.Body>
    </Sidebar.Root>
  );
}

function BeforeState({
  projects,
  generations,
  dock,
  onCreateProject,
  onOpenAllGenerations,
  onOpenProject,
  onOpenProjects,
  projectError,
}: {
  projects: StudioProject[];
  generations: GalleryItem[];
  dock: StudioDockProps;
  onCreateProject: (name: string) => Promise<void>;
  onOpenAllGenerations: () => void;
  onOpenProject: (project: StudioProject) => void;
  onOpenProjects: () => boolean;
  projectError?: string;
}) {
  const [galleryTab, setGalleryTab] = useState("explore");
  const heroImages = useMemo(() => {
    const ready = generations
      .filter((item) => item.status === "ready" && item.src !== "")
      .slice(0, 3)
      .map((item) => item.src);
    return ready.length === 3 ? (ready as [string, string, string]) : null;
  }, [generations]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col items-center overflow-y-auto">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[600px]"
        style={{
          backgroundImage: HERO_DOTS,
          backgroundSize: "14px 14px",
          maskImage: HERO_DOTS_MASK,
          WebkitMaskImage: HERO_DOTS_MASK,
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[600px]"
        style={{ backgroundImage: HERO_GLOW }}
      />

      <div className="relative flex w-full flex-col items-center gap-8 px-3 pb-12 pt-8 sm:gap-12 sm:px-6 sm:pb-16 sm:pt-16">
        <div className="flex w-full flex-col items-center gap-6 sm:gap-8">
          <div className="flex w-full flex-col items-center gap-4 sm:gap-5">
            {heroImages != null ? (
              <HeroComposition images={heroImages} alt="Recent UltraVision restoration outputs" />
            ) : (
              <div className="grid w-full max-w-[760px] gap-3 sm:grid-cols-3">
                <div className="rounded-q-400 border border-q-border-subtle bg-q-background-secondary p-5">
                  <Icon as={IconShieldOutlined} size="lg" />
                  <Typography as="h3" variant="title-sm-semi-bold" className="mt-4">Fidelity Lock</Typography>
                  <Typography as="p" variant="body-sm-regular" color="secondary" className="mt-2">Aspect ratio, framing and geometry stay locked to the source.</Typography>
                </div>
                <div className="rounded-q-400 border border-q-border-subtle bg-q-background-secondary p-5">
                  <Icon as={IconImageOutlined} size="lg" />
                  <Typography as="h3" variant="title-sm-semi-bold" className="mt-4">Image Master</Typography>
                  <Typography as="p" variant="body-sm-regular" color="secondary" className="mt-2">Restoration and proportional upscale up to 32K when the source and engine allow it.</Typography>
                </div>
                <div className="rounded-q-400 border border-q-border-subtle bg-q-background-secondary p-5">
                  <Icon as={IconFilmOutlined} size="lg" />
                  <Typography as="h3" variant="title-sm-semi-bold" className="mt-4">Video Master</Typography>
                  <Typography as="p" variant="body-sm-regular" color="secondary" className="mt-2">Noise, focus, detail and high-resolution mastering with source geometry preserved.</Typography>
                </div>
              </div>
            )}
            <div className="text-center">
              <Typography as="h1" variant="headline-md-bold" color="primary" className="uppercase">
                Niko UltraVision Pro
              </Typography>
              <Typography as="p" variant="body-md-regular" color="secondary" className="mt-2 max-w-[720px]">
                Professional image and video restoration with non-destructive proportional enhancement.
              </Typography>
            </div>
          </div>
          <StudioPromptBox {...dock} />
        </div>

        <div className="flex w-full max-w-[900px] flex-col items-start gap-5">
          <Tabs.Root
            className="example-presets-tabs"
            variant="segmented"
            shape="pill"
            surface="glass"
            tone="glass"
            value={galleryTab}
            onValueChange={(value) => {
              const nextTab = String(value);
              if (nextTab === "projects" && !onOpenProjects()) return;
              setGalleryTab(nextTab);
            }}
          >
            <Tabs.List items={GALLERY_TABS} />
          </Tabs.Root>

          {projectError != null && galleryTab === "projects" ? (
            <Typography as="p" variant="body-sm-regular" color="danger">
              {projectError}
            </Typography>
          ) : null}

          <div key={galleryTab} className="home-gallery-panel w-full">
            {galleryTab === "projects" ? (
              <MyProjects
                projects={projects}
                generations={generations}
                onCreateProject={onCreateProject}
                onOpenAllGenerations={onOpenAllGenerations}
                onOpenProject={onOpenProject}
              />
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {[
                  ["1. Import", "Load one source image or video. Its intrinsic dimensions define the protected aspect ratio."],
                  ["2. Fidelity", "Fidelity Pro is the default. Archive, Cinema Restore and Ultra Detail remain available."],
                  ["3. Resolution", "Choose the master target. The second dimension is calculated from the original ratio."],
                  ["4. Quality control", "Review the generated master in history and compare it with the original before delivery."],
                ].map(([title, description]) => (
                  <div key={title} className="rounded-q-400 border border-q-border-subtle bg-q-background-secondary p-4">
                    <Typography as="h3" variant="title-sm-semi-bold">{title}</Typography>
                    <Typography as="p" variant="body-sm-regular" color="secondary" className="mt-2">{description}</Typography>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function AfterPromptDock({ dock }: { dock: StudioDockProps }) {
  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center px-2 pb-2 pt-16 sm:px-4 sm:pb-4 sm:pt-24"
      style={{
        backgroundImage:
          "linear-gradient(to bottom, transparent 0%, var(--hf-color-background-primary) 100%)",
      }}
    >
      <StudioPromptBox
        {...dock}
        surface="glass"
        className="pointer-events-auto w-[900px] max-w-full"
      />
    </div>
  );
}

function GenerationsState({
  items,
  previewItems,
  title,
  loading,
  error,
  hasMore,
  loadingMore,
  onLoadMore,
  manualLoadMore,
  dock,
}: {
  items: GalleryItem[];
  previewItems: GalleryItem[];
  title: string;
  loading: boolean;
  error?: string;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => Promise<unknown>;
  manualLoadMore: boolean;
  dock: StudioDockProps;
}) {
  const emptyStateImages = useMemo(() => {
    const ready = previewItems
      .filter((item) => item.status === "ready" && item.src !== "")
      .slice(0, 3)
      .map((item) => item.src);
    return [
      ready[0] ?? (appMeta.marketplace_cover_url ?? appMeta.og_image_url ?? ""),
      ready[1] ?? (appMeta.marketplace_cover_url ?? appMeta.og_image_url ?? ""),
      ready[2] ?? (appMeta.marketplace_cover_url ?? appMeta.og_image_url ?? ""),
    ] as const;
  }, [previewItems]);
  const showBlockingError = error != null && items.length === 0 && !import.meta.env.DEV;
  const showInlineError = error != null && !import.meta.env.DEV;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col px-2 pb-[22rem] pt-2 sm:px-4 sm:pb-40 sm:pt-4">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Loader size="md" color="neutral" aria-label="Loading generation history" />
          </div>
        ) : showBlockingError ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <Typography as="p" variant="body-sm-regular" color="danger">
              {error}
            </Typography>
            <Button variant="tertiary" size="sm" onClick={() => void onLoadMore()}>
              Retry
            </Button>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            {showInlineError ? (
              <div className="flex shrink-0 items-center justify-between gap-3 rounded-q-300 bg-q-transparent-light-05 px-3 py-2">
                <Typography as="p" variant="caption-sm-regular" color="danger">
                  {error}
                </Typography>
                <Button variant="tertiary" size="xs" onClick={() => void onLoadMore()}>
                  Retry
                </Button>
              </div>
            ) : null}
            <UserGenerations
              items={items}
              title={title}
              emptyState={{
                images: emptyStateImages,
                title:
                  title === "All Generations" ? "No generations yet" : `No generations in ${title}`,
                description: "Describe an idea below, then generate the first result.",
              }}
              hasMore={hasMore && !manualLoadMore}
              loadingMore={loadingMore}
              onLoadMore={onLoadMore}
            />
            {manualLoadMore && hasMore ? (
              <div className="flex shrink-0 justify-center">
                <Button
                  variant="tertiary"
                  size="sm"
                  disabled={loadingMore}
                  onClick={() => void onLoadMore()}
                >
                  {loadingMore ? "Loading…" : "Load older"}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </div>
      <AfterPromptDock dock={dock} />
    </div>
  );
}

export function StudioTemplate() {
  const jobClient = useFnfJobClient<typeof STUDIO_JOBS>();
  const mediaClient = useFnfMediaClient();
  const scopeKey = useRequiredFnfScopeKey();
  const queryClient = useQueryClient();
  const run = useGenerationRun(jobClient, { scopeKey });
  const [view, setView] = useState<StudioView>({ kind: "home" });
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState("image");
  const [settingValues, setSettingValues] = useState<Record<string, string>>({
    target: "4k",
    profile: "fidelity",
  });
  const [references, setReferences] = useState<Record<string, AssetSelection | undefined>>({});
  const [localUploads, setLocalUploads] = useState<AssetLibraryItem[]>([]);
  const [linkOverrides, setLinkOverrides] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pendingSignInUrl, setPendingSignInUrl] = useState<string | null>(null);
  const prependedIds = useRef(new Set<string>());
  const linkingIds = useRef(new Set<string>());
  const runProjectId = useRef<string | undefined>(undefined);
  const navigateToAllOnSubmitRef = useRef(false);
  const projectsQueryKey = useMemo(
    () => ["studio", "scope", scopeKey, "projects"] as const,
    [scopeKey],
  );

  const history = useInfiniteQuery({
    ...jobsFeedQueryOptions(jobClient, HISTORY_QUERY, { scopeKey }),
    getNextPageParam: getNextStudioCursor,
    select: flattenFeedPages,
  });
  const imageHistory = useInfiniteQuery({
    ...jobsFeedQueryOptions(jobClient, IMAGE_LIBRARY_QUERY, { scopeKey }),
    getNextPageParam: getNextStudioCursor,
    select: flattenFeedPages,
  });
  const liveGenerations = useMemo(
    () => [...(history.data ?? []), ...(imageHistory.data ?? [])],
    [history.data, imageHistory.data],
  );
  useLiveFeedGenerations(jobClient, liveGenerations, { scopeKey });
  const persistedUploads = useInfiniteQuery({
    queryKey: ["fnf", "scope", scopeKey, "media", "image"],
    queryFn: ({ pageParam }) =>
      mediaClient.list({
        type: "image",
        size: 40,
        ...(pageParam !== undefined ? { cursor: pageParam } : {}),
      }),
    initialPageParam: undefined as string | number | undefined,
    getNextPageParam: getNextCursor,
    select: flattenMediaPages,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const projectData = useQuery({
    queryKey: projectsQueryKey,
    queryFn: () => listStudioProjectsFn(),
    refetchOnWindowFocus: false,
  });

  const generations = useMemo(() => {
    const runIds = new Set(run.generations.map((generation) => generation.id));
    return [
      ...run.generations,
      ...(history.data ?? []).filter((generation) => !runIds.has(generation.id)),
    ];
  }, [history.data, run.generations]);
  const generationProjects = useMemo(() => {
    const result: Record<string, string> = {};
    for (const link of projectData.data?.links ?? []) result[link.generationId] = link.projectId;
    return { ...result, ...linkOverrides };
  }, [linkOverrides, projectData.data?.links]);
  const galleryItems = useMemo(
    () =>
      generations
        .map((generation) => generationToGalleryItem(generation, generationProjects[generation.id]))
        .filter((item): item is GalleryItem => item != null),
    [generationProjects, generations],
  );
  const projectItems = useMemo(() => indexProjectItems(galleryItems), [galleryItems]);
  const projects = useMemo<StudioProject[]>(
    () =>
      (projectData.data?.projects ?? []).map((project) => {
        const items = projectItems.get(project.id) ?? [];
        const base: StudioProject = {
          id: project.id,
          name: project.name,
          generationCount: project.generationCount,
          updatedAt: project.updatedAt,
        };
        const cover = latestProjectCover(base, items);
        return cover ? { ...base, cover } : base;
      }),
    [projectData.data?.projects, projectItems],
  );
  const selectedProject = useMemo(
    () =>
      view.kind === "project"
        ? projects.find((project) => project.id === view.projectId)
        : undefined,
    [projects, view],
  );
  const visibleItems = useMemo(
    () => (view.kind === "project" ? (projectItems.get(view.projectId) ?? []) : galleryItems),
    [galleryItems, projectItems, view],
  );
  const libraryGenerations = useMemo(() => {
    const generationIds = new Set(generations.map((generation) => generation.id));
    return [
      ...generations,
      ...(imageHistory.data ?? []).filter((generation) => !generationIds.has(generation.id)),
    ];
  }, [generations, imageHistory.data]);

  const libraryItems = useMemo(() => {
    const localIds = new Set(localUploads.map((item) => item.ref?.id));
    return [
      ...localUploads,
      ...(persistedUploads.data ?? [])
        .filter((ref) => !localIds.has(ref.id))
        .map(mediaRefToAssetItem)
        .filter((item): item is AssetLibraryItem => item != null),
      ...libraryGenerations
        .map(generationToAssetItem)
        .filter((item): item is AssetLibraryItem => item != null),
    ];
  }, [libraryGenerations, localUploads, persistedUploads.data]);
  const loadMoreUploads =
    persistedUploads.data == null ||
    (persistedUploads.error != null && !persistedUploads.isFetchNextPageError)
      ? persistedUploads.refetch
      : persistedUploads.fetchNextPage;
  const loadMoreLibraryVideos =
    history.data == null || (history.error != null && !history.isFetchNextPageError)
      ? history.refetch
      : history.fetchNextPage;
  const loadMoreLibraryImages =
    imageHistory.data == null || (imageHistory.error != null && !imageHistory.isFetchNextPageError)
      ? imageHistory.refetch
      : imageHistory.fetchNextPage;

  const libraryPagination = useMemo<AssetLibraryPagination>(
    () => ({
      uploads: {
        hasMore: persistedUploads.hasNextPage === true,
        loading: persistedUploads.isPending || persistedUploads.isFetchingNextPage,
        ...(persistedUploads.error instanceof Error
          ? { error: persistedUploads.error.message }
          : {}),
        onLoadMore: loadMoreUploads,
      },
      image: {
        hasMore: imageHistory.hasNextPage === true,
        loading: imageHistory.isPending || imageHistory.isFetchingNextPage,
        ...(imageHistory.error instanceof Error ? { error: imageHistory.error.message } : {}),
        onLoadMore: loadMoreLibraryImages,
      },
      video: {
        hasMore: history.hasNextPage === true,
        loading: history.isPending || history.isFetchingNextPage,
        ...(history.error instanceof Error ? { error: history.error.message } : {}),
        onLoadMore: loadMoreLibraryVideos,
      },
    }),
    [
      history.error,
      history.hasNextPage,
      history.isFetchingNextPage,
      history.isPending,
      imageHistory.error,
      imageHistory.hasNextPage,
      imageHistory.isFetchingNextPage,
      imageHistory.isPending,
      loadMoreLibraryImages,
      loadMoreLibraryVideos,
      loadMoreUploads,
      persistedUploads.error,
      persistedUploads.hasNextPage,
      persistedUploads.isFetchingNextPage,
      persistedUploads.isPending,
    ],
  );

  const input = useMemo<StudioGenerationInput>(() => {
    const source = references.source?.ref;
    const profile = settingValues.profile ?? "fidelity";
    const output = lockedOutputSize(references.source, settingValues.target ?? "4k");
    const base = { sourceWidth: source?.meta?.width, sourceHeight: source?.meta?.height, outputWidth: output?.width, outputHeight: output?.height };
    if (mode === "video") {
      return { model: "topaz_video", media: { video: source ? [source] : [] }, settings: { ...base, scaleFactor: "Original", model: "slp-2.5", enhancement: true, enhancementModel: profile === "detail" ? "rhea-1" : "slp-2.5", focusFix: "Normal", parameters: "auto", grainEnabled: profile === "cinema", frameInterpolation: false } } as StudioGenerationInput;
    }
    return { model: "topaz_image", media: { image: source ? [source] : [] }, settings: { ...base, model: profile === "detail" ? "Low Resolution V2" : "High Fidelity V2", denoise: profile === "archive" ? 0.15 : 0.2, sharpen: profile === "detail" ? 0.45 : 0.3, faceEnhancement: profile !== "archive", faceEnhancementCreativity: 0, faceEnhancementStrength: 0.35 } } as StudioGenerationInput;
  }, [mode, references.source, settingValues.profile, settingValues.target]);

  const hasReference = Object.values(references).some((selection) => selection?.ref != null);
  const canGenerate = hasReference;
  const runFailure = useMemo(() => {
    for (const generation of run.generations) {
      const media = selectGenerationMedia(generation);
      if (media.kind !== "empty" || !media.terminal) continue;
      return (
        getGenerationFailureLabel(generation) ??
        (media.reason === "preview_unavailable"
          ? "The generation completed without previewable media."
          : getGenerationStatusLabel(generation))
      );
    }
    return undefined;
  }, [run.generations]);
  const cost = useQuery({
    ...costQueryOptions(jobClient, input, { enabled: canGenerate, scopeKey }),
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    const fresh =
      history.data == null
        ? []
        : run.generations.filter((generation) => !prependedIds.current.has(generation.id));
    if (fresh.length > 0) {
      for (const generation of fresh) prependedIds.current.add(generation.id);
      prependGenerations(queryClient, HISTORY_QUERY, fresh, { scopeKey });
    }

    const projectId = runProjectId.current;
    if (!projectId) return;
    const unlinked = run.generations.filter((generation) => !linkingIds.current.has(generation.id));
    if (unlinked.length === 0) return;
    const ids = unlinked.map((generation) => generation.id);
    for (const id of ids) linkingIds.current.add(id);
    setLinkOverrides((current) => ({
      ...current,
      ...Object.fromEntries(ids.map((id) => [id, projectId])),
    }));
    void linkProjectWithOneRetry(() =>
      linkStudioGenerationsFn({ data: { projectId, generationIds: ids } }),
    )
      .then(() => queryClient.invalidateQueries({ queryKey: projectsQueryKey }))
      .catch((error: unknown) => {
        for (const id of ids) linkingIds.current.delete(id);
        setLinkOverrides((current) => {
          const next = { ...current };
          for (const id of ids) delete next[id];
          return next;
        });
        setSubmitError(error instanceof Error ? error.message : "Could not save the project link.");
      });
  }, [history.data, projectsQueryKey, queryClient, run.generations, scopeKey]);

  useEffect(() => {
    if (!navigateToAllOnSubmitRef.current || run.generations.length === 0) return;
    navigateToAllOnSubmitRef.current = false;
    setView({ kind: "all" });
  }, [run.generations.length]);

  const handleUpload = async (file: File): Promise<AssetSelection> => {
    const uploaded = await uploadAsset(file);
    const item = { ...uploaded, personal: true };
    setLocalUploads((current) => [
      item,
      ...current.filter((candidate) => candidate.ref?.id !== uploaded.ref?.id),
    ]);
    return item;
  };

  const handleCreateProject = async (name: string) => {
    const project = await createStudioProjectFn({ data: { name } });
    await queryClient.invalidateQueries({ queryKey: projectsQueryKey });
    setView({ kind: "project", projectId: project.id });
  };

  const handleRenameProject = async (projectId: string, name: string) => {
    await renameStudioProjectFn({ data: { projectId, name } });
    await queryClient.invalidateQueries({ queryKey: projectsQueryKey });
  };

  const handleDeleteProject = async (projectId: string) => {
    await deleteStudioProjectFn({ data: { projectId } });
    await queryClient.invalidateQueries({ queryKey: projectsQueryKey });
    if (view.kind === "project" && view.projectId === projectId) {
      setView({ kind: "all" });
    }
  };

  const allowPersonalNavigation = useCallback(() => {
    const signInUrl = getSignInUrl(
      scopeKey,
      `${window.location.pathname}${window.location.search}${window.location.hash}`,
    );
    if (signInUrl != null) {
      setPendingSignInUrl(signInUrl);
      return false;
    }
    return true;
  }, [scopeKey]);

  const handleViewChange = useCallback(
    (nextView: StudioView) => {
      if (nextView.kind !== "home" && !allowPersonalNavigation()) return;
      setView(nextView);
    },
    [allowPersonalNavigation],
  );

  const handleGenerate = () => {
    if (!canGenerate || run.status === "submitting") return;
    if (!allowPersonalNavigation()) return;
    setSubmitError(null);
    runProjectId.current = view.kind === "project" ? view.projectId : undefined;
    // The host approval iframe owns confirmation. Do not navigate away from
    // Home until the approved submit has actually created a generation.
    navigateToAllOnSubmitRef.current = runProjectId.current == null;
    void run.start(input).then((generations) => {
      if (generations.length === 0) navigateToAllOnSubmitRef.current = false;
    });
  };

  const promptUploads = PROMPT_UPLOADS.map((upload) => ({
    ...upload,
    selection: references[upload.id],
  }));
  const dock: StudioDockProps = {
    modes: PROMPT_MODES,
    mode,
    onModeChange: setMode,
    settings: mode === "video" ? VIDEO_PROMPT_SETTINGS : IMAGE_PROMPT_SETTINGS,
    settingValues,
    onSettingChange: (id, value) => setSettingValues((current) => ({ ...current, [id]: value })),
    uploads: promptUploads,
    assetLibrary: {
      items: libraryItems,
      onUpload: handleUpload,
      pagination: libraryPagination,
    },
    onAddMedia: (selection) => {
      const target = PROMPT_UPLOADS.find((upload) => references[upload.id] == null)?.id;
      if (target == null) {
        setSubmitError("Remove the current source before adding another.");
        return;
      }
      setSubmitError(null);
      setMode(selection.kind === "video" || selection.type.startsWith("video/") ? "video" : "image");
      setReferences((current) => ({ ...current, [target]: selection }));
    },
    onUploadSelect: (id, selection) => {
      setSubmitError(null);
      setMode(selection.kind === "video" || selection.type.startsWith("video/") ? "video" : "image");
      setReferences((current) => ({ ...current, [id]: selection }));
    },
    onUploadRemove: (id) => {
      setSubmitError(null);
      setReferences((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    },
    showTemplatePicker: false,
    onSelectTemplate: () => undefined,
    placeholder: "Optional restoration notes…",
    prompt,
    onPromptChange: setPrompt,
    cost: cost.data?.credits ?? "—",
    onGenerate: handleGenerate,
    submitting: run.status === "submitting",
    generateDisabled: !canGenerate,
    error: submitError ?? run.error?.message ?? runFailure ?? run.warning ?? undefined,
  };

  return (
    <div className="flex h-dvh overflow-hidden bg-q-background-primary">
      <SignInModal
        open={pendingSignInUrl != null}
        signInUrl={pendingSignInUrl}
        onOpenChange={(open) => {
          if (!open) setPendingSignInUrl(null);
        }}
      />
      <div className="hidden h-full shrink-0 lg:block">
        <StudioSidebar
          view={view}
          onViewChange={handleViewChange}
          projects={projects}
          onCreateProject={handleCreateProject}
          onRenameProject={handleRenameProject}
          onDeleteProject={handleDeleteProject}
        />
      </div>
      <main className="relative flex min-w-0 flex-1 flex-col">
        <div className="absolute left-3 top-3 z-20 lg:hidden">
          <Modal.Root open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
            <Modal.Trigger
              render={
                <Button
                  variant="tertiary"
                  size="sm"
                  iconOnly
                  aria-label="Open navigation"
                  start={<Icon as={IconSidebarVisibleLeftWideOutlined} size="md" />}
                />
              }
            />
            <Modal.Content
              size="xs"
              className="!left-0 !top-0 !h-dvh !max-h-none !w-[min(20rem,calc(100vw-1rem))] !rounded-l-none !rounded-r-[var(--hf-radius-600)] !p-0 ![transform:translateX(0)] data-[ending-style]:![transform:translateX(-100%)] data-[starting-style]:![transform:translateX(-100%)]"
            >
              <Modal.Title className="sr-only">Studio navigation</Modal.Title>
              <StudioSidebar
                view={view}
                onViewChange={handleViewChange}
                projects={projects}
                onCreateProject={handleCreateProject}
                onRenameProject={handleRenameProject}
                onDeleteProject={handleDeleteProject}
                onClose={() => setMobileSidebarOpen(false)}
              />
            </Modal.Content>
          </Modal.Root>
        </div>
        {view.kind === "home" ? (
          <BeforeState
            projects={projects}
            generations={galleryItems}
            dock={dock}
            onCreateProject={handleCreateProject}
            onOpenAllGenerations={() => handleViewChange({ kind: "all" })}
            onOpenProject={(project) =>
              handleViewChange({ kind: "project", projectId: project.id })
            }
            onOpenProjects={allowPersonalNavigation}
            projectError={
              projectData.error instanceof Error ? projectData.error.message : undefined
            }
          />
        ) : (
          <GenerationsState
            items={visibleItems}
            previewItems={galleryItems}
            title={selectedProject?.name ?? "All Generations"}
            loading={history.isPending && visibleItems.length === 0}
            error={history.error instanceof Error ? history.error.message : undefined}
            hasMore={history.error == null && history.hasNextPage === true}
            loadingMore={history.isFetchingNextPage}
            onLoadMore={loadMoreLibraryVideos}
            manualLoadMore={view.kind === "project"}
            dock={dock}
          />
        )}
      </main>
    </div>
  );
}
