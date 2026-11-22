import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import type { SkillManagerConfig } from "./config.ts"
import { SkillManagerError, toSkillManagerError } from "./errors.ts"
import { parseSkillDocument } from "./frontmatter.ts"
import { createPreview, type PreviewStore } from "./inspect.ts"
import { installPreview, uninstallSkill, type InstallerDeps } from "./install.ts"
import type { Logger } from "./log.ts"
import { MANAGEMENT_SKILL_ID } from "./management-skill.ts"
import { safeSkillDirectory, sanitizeSkillId } from "./paths.ts"
import type { RegistryStore } from "./registry.ts"
import { resolveBundle, searchAll, type SourceKind } from "./sources/index.ts"
import type { SourceContext } from "./sources/context.ts"
import type { Candidate, Preview, Registrar, ToolResult } from "./types.ts"

export interface ToolInvocation {
  readonly sessionID?: string
  readonly agent?: string
  readonly messageID?: string
  readonly id?: string
}

export interface ToolDeps {
  readonly projectDir: string
  readonly skillsRoot: string
  readonly stateDir: string
  readonly config: SkillManagerConfig
  readonly registry: RegistryStore
  readonly registrar: Registrar
  readonly previews: PreviewStore
  readonly log: Logger
  readonly context: SourceContext
  readonly installer: InstallerDeps
  readonly confirmInstall: (details: { id: string; source: string; files: number }, invocation?: ToolInvocation) => Promise<void>
  readonly confirmUninstall: (details: { id: string; path: string }, invocation?: ToolInvocation) => Promise<void>
  readonly version: string
}

export interface ToolOutput {
  readonly content: string
  readonly metadata?: Record<string, unknown>
}

function result<T extends Record<string, unknown>>(value: T): ToolOutput {
  return { content: JSON.stringify(value, null, 2), metadata: value }
}

function failure(error: unknown): ToolOutput {
  return result(toSkillManagerError(error).toJSON() as unknown as Record<string, unknown>)
}

async function run<T extends Record<string, unknown>>(operation: () => Promise<T>): Promise<ToolOutput> {
  try {
    return result(await operation())
  } catch (error) {
    return failure(error)
  }
}

function previewPublic(preview: Preview, options: { includeContent?: boolean } = {}) {
  const skillFile = preview.files.find((file) => file.path === "SKILL.md")
  const content = skillFile?.content ?? ""
  const max = 24_000
  const truncated = content.length > max
  return {
    inspectToken: preview.token,
    id: preview.suggestedId,
    name: preview.parsed.name,
    ...(preview.parsed.description ? { description: preview.parsed.description } : {}),
    autoinvoke: preview.parsed.autoinvoke,
    source: preview.source,
    metrics: preview.metrics ?? null,
    compatibility: preview.compatibility,
    quality: preview.quality,
    security: {
      status: preview.security.status,
      counts: preview.security.counts,
      findings: preview.security.findings.slice(0, 50),
    },
    files: preview.files.map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })),
    target: `.opencode/skills/${preview.suggestedId}/SKILL.md`,
    notes: preview.notes,
    ...(options.includeContent === false
      ? {}
      : {
          skillMd: truncated ? `${content.slice(0, max)}\n\n[…truncated, ${content.length - max} characters omitted]` : content,
          truncated,
        }),
  }
}

function candidatePublic(candidate: Candidate, installed: ReadonlyMap<string, string>) {
  const installedId = installed.get(candidate.id)
  return {
    id: candidate.id,
    name: candidate.name,
    ...(candidate.description ? { description: candidate.description } : {}),
    source: candidate.source,
    metrics: candidate.metrics ?? null,
    installs: candidate.installs ?? candidate.metrics?.installs?.value ?? null,
    compatibility: candidate.compatibility,
    quality: candidate.quality,
    ...(candidate.security
      ? { security: { status: candidate.security.status, counts: candidate.security.counts } }
      : {}),
    ...(installedId ? { installed: true, installedId } : {}),
    ...(candidate.inspectToken ? { inspectToken: candidate.inspectToken } : {}),
  }
}

async function installedIds(registrar: Registrar): Promise<Map<string, string>> {
  const listed = await registrar.list()
  return new Map(listed.map((skill) => [skill.id, skill.path]))
}

async function scanProjectSkills(deps: ToolDeps): Promise<
  {
    id: string
    name: string
    description?: string
    path: string
    managed: boolean
    advertised: boolean
    skillMdHash: string
  }[]
> {
  const result: {
    id: string
    name: string
    description?: string
    path: string
    managed: boolean
    advertised: boolean
    skillMdHash: string
  }[] = []
  let entries
  try {
    entries = await readdir(deps.skillsRoot, { withFileTypes: true })
  } catch {
    return result
  }
  const hashOf = (text: string) => createHash("sha256").update(text).digest("hex")
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue
    if (entry.isDirectory()) {
      const file = path.join(deps.skillsRoot, entry.name, "SKILL.md")
      try {
        const text = await readFile(file, "utf8")
        const { parsed } = parseSkillDocument(file, text)
        result.push({
          id: entry.name,
          name: parsed.name,
          ...(parsed.description ? { description: parsed.description } : {}),
          path: file,
          managed: Boolean(deps.registry.get(entry.name)),
          advertised: Boolean(parsed.description?.trim()) && parsed.autoinvoke !== false,
          skillMdHash: hashOf(text),
        })
      } catch {
        // Not a skill directory.
      }
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const file = path.join(deps.skillsRoot, entry.name)
      try {
        const text = await readFile(file, "utf8")
        const { parsed } = parseSkillDocument(file, text)
        result.push({
          id: entry.name.replace(/\.md$/i, ""),
          name: parsed.name,
          ...(parsed.description ? { description: parsed.description } : {}),
          path: file,
          managed: Boolean(deps.registry.get(entry.name.replace(/\.md$/i, ""))),
          advertised: Boolean(parsed.description?.trim()) && parsed.autoinvoke !== false,
          skillMdHash: hashOf(text),
        })
      } catch {
        // Not a skill file.
      }
    }
  }
  return result.sort((a, b) => a.id.localeCompare(b.id))
}

function scopeOf(filePath: string, projectDir: string): "builtin" | "project" | "global" | "unknown" {
  if (filePath.startsWith("skill://")) return "builtin"
  const normalized = path.resolve(filePath)
  if (normalized.startsWith(path.resolve(projectDir))) return "project"
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ""
  if (home && normalized.startsWith(path.resolve(home))) return "global"
  return "unknown"
}

export function createToolHandlers(deps: ToolDeps) {
  return {
    async search(input: {
      query?: string
      source?: SourceKind
      limit?: number
    }): Promise<ToolOutput> {
      return run(async () => {
        const query = String(input.query ?? "").trim()
        if (!query) throw new SkillManagerError("INVALID_INPUT", "query is required")
        const limit = Math.min(20, Math.max(1, Number(input.limit ?? 8) || 8))
        const source = (input.source ?? "auto") as SourceKind
        deps.log.info("search-started", { query, source, limit })
        const candidates = await searchAll(deps.context, query, source, limit)
        const installed = await installedIds(deps.registrar)
        const enriched: Candidate[] = []
        for (const candidate of candidates) {
          if (candidate.files && candidate.files.length > 0 && !candidate.inspectToken) {
            const skillFile = candidate.files.find((file) => file.path === "SKILL.md")
            const parsed = skillFile
              ? parseSkillDocument("SKILL.md", skillFile.content).parsed
              : { name: candidate.name, body: "", frontmatter: {} }
            const preview = deps.previews.put(
              createPreview(
                deps.projectDir,
                {
                  source: candidate.source,
                  files: candidate.files,
                  parsed: {
                    ...parsed,
                    ...(candidate.description ? { description: candidate.description } : {}),
                  },
                  suggestedId: candidate.id,
                  metrics: candidate.metrics,
                  notes: [],
                },
                { allowScripts: deps.config.allowScripts, ttlMs: deps.config.previewTtlMs },
              ),
            )
            enriched.push({ ...candidate, inspectToken: preview.token, security: preview.security })
          } else {
            enriched.push(candidate)
          }
        }
        deps.log.info("candidates-found", { query, count: enriched.length })
        return {
          ok: true,
          query,
          source,
          count: enriched.length,
          candidates: enriched.map((candidate) => candidatePublic(candidate, installed)),
          messages: [
            "Search started.",
            `Found ${enriched.length} candidate(s).`,
            "Use skill_inspect with an inspectToken before installing.",
          ],
          notes: [
            "installs come only from skills.sh; stars and repoLastPush come only from the GitHub API.",
            "quality.score is a heuristic based on the listed signals, not an external benchmark.",
            "Use skill_inspect with an inspectToken before installing.",
            ...((source === "github" || source === "all") && !deps.context.githubToken
              ? ["GitHub code search requires GITHUB_TOKEN; without it the manager uses repository search plus SKILL.md tree scans."]
              : []),
          ],
        }
      })
    },

    async inspect(input: {
      token?: string
      source?: string
      path?: string
      ref?: string
      name?: string
    }): Promise<ToolOutput> {
      return run(async () => {
        let preview: Preview
        if (input.token) {
          preview = deps.previews.get(String(input.token), deps.projectDir)
        } else {
          if (!input.source) throw new SkillManagerError("INVALID_INPUT", "Provide token or source.")
          const bundle = await resolveBundle(deps.context, String(input.source), {
            path: input.path,
            ref: input.ref,
            name: input.name,
            allowSearch: false,
          })
          preview = deps.previews.put(
            createPreview(deps.projectDir, bundle, {
              allowScripts: deps.config.allowScripts,
              ttlMs: deps.config.previewTtlMs,
            }),
          )
        }
        const target = safeSkillDirectory(deps.skillsRoot, preview.suggestedId)
        const existing = deps.registry.get(preview.suggestedId)
        const directoryExists = await readFile(path.join(target, "SKILL.md"), "utf8")
          .then(() => true)
          .catch(() => false)
        return {
          ok: true,
          ...previewPublic(preview),
          messages: [
            "Inspection completed.",
            `Security scan: ${preview.security.status}.`,
            "Nothing was written to disk.",
          ],
          conflicts: {
            registry: existing
              ? { installed: true, source: existing.source.url, hash: existing.hash }
              : null,
            directoryExists,
            unmanaged: directoryExists && !existing,
          },
          next: "Call skill_install with this inspectToken after the user approves.",
        }
      })
    },

    async install(input: {
      token?: string
      source?: string
      path?: string
      ref?: string
      name?: string
      overwrite?: "error" | "replace" | "replace-unmanaged"
      allowWarnings?: boolean
    }, invocation?: ToolInvocation): Promise<ToolOutput> {
      return run(async () => {
        let preview: Preview
        if (input.token) {
          preview = deps.previews.get(String(input.token), deps.projectDir)
        } else {
          if (!input.source) throw new SkillManagerError("INVALID_INPUT", "Provide token or source.")
          const bundle = await resolveBundle(deps.context, String(input.source), {
            path: input.path,
            ref: input.ref,
            name: input.name,
            allowSearch: true,
          })
          preview = deps.previews.put(
            createPreview(deps.projectDir, bundle, {
              allowScripts: deps.config.allowScripts,
              ttlMs: deps.config.previewTtlMs,
            }),
          )
        }
        const targetId = sanitizeSkillId(input.name ?? preview.suggestedId)
        if (targetId === MANAGEMENT_SKILL_ID) {
          throw new SkillManagerError("INVALID_INPUT", "The built-in Skill Discovery skill cannot be replaced.")
        }
        const result = await installPreview(deps.installer, preview, {
          ...(input.name ? { id: sanitizeSkillId(input.name) } : {}),
          overwrite: input.overwrite ?? "error",
          allowWarnings: input.allowWarnings === true,
          confirm: () =>
            deps.confirmInstall(
              { id: targetId, source: preview.source.url, files: preview.files.length },
              invocation,
            ),
        })
        deps.log.info("install-complete", {
          id: result.id,
          status: result.status,
          registered: result.registered,
          verified: result.verified,
        })
        return { ...result }
      })
    },

    async list(): Promise<ToolOutput> {
      return run(async () => {
        const registered = await deps.registrar.list()
        const onDisk = await scanProjectSkills(deps)
        const registeredMap = new Map(registered.map((skill) => [skill.id, skill]))
        const ids = new Set<string>([...registeredMap.keys(), ...onDisk.map((skill) => skill.id), ...deps.registry.entries().map((entry) => entry.id)])
        const skills = [...ids].sort().map((id) => {
          const entry = deps.registry.get(id)
          const disk = onDisk.find((skill) => skill.id === id)
          const current = registeredMap.get(id)
          const expectedHash = entry?.files.find((file) => file.path === "SKILL.md")?.sha256
          const modified = Boolean(disk && expectedHash && disk.skillMdHash !== expectedHash)
          return {
            id,
            name: disk?.name ?? current?.name ?? id,
            ...(disk?.description ?? current?.description
              ? { description: disk?.description ?? current?.description }
              : {}),
            scope: current ? scopeOf(current.path, deps.projectDir) : disk ? "project" : "unknown",
            path: disk?.path ?? current?.path ?? null,
            managed: Boolean(entry),
            registered: Boolean(current),
            advertised:
              disk?.advertised ??
              (Boolean(current?.description?.trim()) && current?.autoinvoke !== false),
            modified,
            missing: Boolean(entry && !disk),
            source: entry?.source ?? null,
            installedAt: entry?.installedAt ?? null,
            updatedAt: entry?.updatedAt ?? null,
            security: entry?.security ?? null,
          }
        })
        return {
          ok: true,
          project: deps.projectDir,
          count: skills.length,
          skills,
          messages: [`Found ${skills.length} skill(s) at this location.`],
          notes: [
            "managed skills have a registry entry and are backed up before updates/removal.",
            "scope=global/builtin entries are visible to OpenCode but are never modified by this project plugin.",
          ],
        }
      })
    },

    async uninstall(input: { id?: string; force?: "unmanaged"; purge?: boolean }, invocation?: ToolInvocation): Promise<ToolOutput> {
      return run(async () => {
        const id = String(input.id ?? "").trim()
        if (!id) throw new SkillManagerError("INVALID_INPUT", "id is required")
        const normalized = sanitizeSkillId(id)
        if (normalized === MANAGEMENT_SKILL_ID) {
          throw new SkillManagerError("INVALID_INPUT", "The built-in Skill Discovery skill cannot be uninstalled.")
        }
        const target = safeSkillDirectory(deps.skillsRoot, normalized)
        const result = await uninstallSkill(deps.installer, normalized, {
          force: input.force,
          purge: input.purge === true,
          confirm: () => deps.confirmUninstall({ id: normalized, path: target }, invocation),
        })
        deps.log.info("uninstall-complete", { id: normalized, removed: result.removed })
        return { ...result }
      })
    },

    async status(): Promise<ToolOutput> {
      return run(async () => {
        const registered = await deps.registrar.list()
        return {
          ok: true,
          plugin: "skill-manager",
          version: deps.version,
          project: deps.projectDir,
          skillsRoot: deps.skillsRoot,
          stateDir: deps.stateDir,
          registered: registered.length,
          managed: deps.registry.entries().length,
          githubToken: Boolean(deps.context.githubToken),
          config: {
            requireConfirmation: deps.config.requireConfirmation,
            allowPrivateHosts: deps.config.allowPrivateHosts,
            allowScripts: deps.config.allowScripts,
            autoAttachDiscoverySkill: deps.config.autoAttachDiscoverySkill,
            injectGuidance: deps.config.injectGuidance,
          },
        }
      })
    },
  }
}

export type ToolHandlers = ReturnType<typeof createToolHandlers>
