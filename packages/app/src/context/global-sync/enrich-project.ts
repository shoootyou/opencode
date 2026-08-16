import type { Project } from "@opencode-ai/sdk/v2/client"
import type { ProjectMeta } from "./types"

export type EnrichProjectChildStore = {
  project: string
  icon?: string
  projectMeta?: ProjectMeta
}

/**
 * Merge a project's server-side metadata (`projectData`) with its local childStore overrides
 * (per-workspace icon override, and - for global/id-less projects - the projectMeta cache) into
 * one enriched project object. Consumed identically by global.tsx's and layout.tsx's `enrich()`.
 */
export function enrichProject<P extends { worktree: string }>(
  project: P,
  childStore: EnrichProjectChildStore,
  projectData: readonly Project[],
): P & Partial<Project> {
  const projectID = childStore.project

  // Explicit identity check, not truthiness. The server's shared global/id-less project row has
  // a literal id of "global" (ProjectV2.ID.make("global")) - a truthy sentinel, not a real
  // per-directory ID. A bare `!projectID` guard goes permanently false once bootstrap resolves
  // childStore.project to that sentinel (~1-1.25s after page load), silently stopping this merge
  // forever after. Treat both "" (not yet resolved) and "global" (resolved to the shared
  // sentinel) as the same case.
  const isGlobalProject = !projectID || projectID === "global"

  const metadata = isGlobalProject
    ? projectData.find((x) => x.worktree === project.worktree)
    : projectData.find((x) => x.id === projectID)

  const base = { ...metadata, ...project }

  // Preserve local icon override from per-workspace localStorage cache (childStore.icon).
  // Without this, different subdirectories of the same git repo would share the same icon from
  // the database instead of using their individual overrides.
  if (childStore.icon) {
    return { ...base, icon: { ...base.icon, override: childStore.icon } }
  }

  // Global/id-less projects don't have their own row in projectData - they share the server's
  // single "global" project row. Merge childStore.projectMeta (name/icon/commands) so
  // per-directory local edits made through the global/id-less save branch (edit-project.ts's
  // `sync.project.meta(...)` call) surface here instead of leaking the shared row's stale data.
  if (isGlobalProject && childStore.projectMeta) {
    return {
      ...base,
      ...childStore.projectMeta,
      icon: { ...base.icon, ...childStore.projectMeta.icon },
    }
  }

  return base
}
