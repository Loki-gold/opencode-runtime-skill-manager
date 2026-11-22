import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import type { SkillManagerConfig } from "./config.ts"
import { SkillManagerError } from "./errors.ts"
import { parseSkillDocument } from "./frontmatter.ts"
import { hashFiles, normalizeText } from "./hash.ts"
import type { Logger } from "./log.ts"
import { safeResolve, safeSkillDirectory, sanitizeSkillId } from "./paths.ts"
import type { RegistryStore } from "./registry.ts"
import { AsyncLock, exists, moveAside, restore, retryFs } from "./sync.ts"
import type {
  InstallResult,
  LocalSkill,
  Preview,
  Registrar,
  RegistryEntry,
  SecurityReport,
  UninstallResult,
} from "./types.ts"

export interface InstallOptions {
  readonly id?: string
  readonly overwrite?: "error" | "replace" | "replace-unmanaged"
  readonly allowWarnings?: boolean
  readonly confirm: () => Promise<void>
}

export interface UninstallOptions {
  readonly force?: "unmanaged"
  readonly purge?: boolean
  readonly confirm: () => Promise<void>
}

export interface InstallerDeps {
  readonly projectDir: string
  readonly skillsRoot: string
  readonly stateDir: string
  readonly registry: RegistryStore
  readonly registrar: Registrar
  readonly log: Logger
  readonly config: SkillManagerConfig
  readonly lock: AsyncLock
}

function localSkill(preview: Preview, id: string, target: string): LocalSkill {
  return {
    id,
    name: preview.parsed.name,
    ...(preview.parsed.description ? { description: preview.parsed.description } : {}),
    ...(preview.parsed.autoinvoke === undefined ? {} : { autoinvoke: preview.parsed.autoinvoke }),
    path: path.join(target, "SKILL.md"),
    content: preview.parsed.body,
  }
}

function entryFor(preview: Preview, id: string, now: string): RegistryEntry {
  return {
    id,
    source: preview.source,
    hash: hashFiles(preview.files),
    installedAt: now,
    updatedAt: now,
    files: preview.files.map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })),
    security: { status: preview.security.status, warnings: preview.security.counts.warn },
    installedBy: "opencode-runtime-skill-manager@0.1.0",
  }
}

function advertised(preview: Preview): boolean {
  return Boolean(preview.parsed.description?.trim()) && preview.parsed.autoinvoke !== false
}

function sameContent(a: string, b: string): boolean {
  return normalizeText(a).trim() === normalizeText(b).trim()
}

async function writeStaging(preview: Preview, staging: string): Promise<void> {
  await mkdir(staging, { recursive: true })
  const seen = new Set<string>()
  for (const file of preview.files) {
    const key = file.path.toLowerCase()
    if (seen.has(key)) {
      throw new SkillManagerError("INVALID_SKILL", `Duplicate file path (case-insensitive): ${file.path}`)
    }
    seen.add(key)
    const target = safeResolve(staging, file.path)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, file.content, "utf8")
  }
  if (!(await exists(path.join(staging, "SKILL.md")))) {
    throw new SkillManagerError("INVALID_SKILL", "SKILL.md is missing from the staged skill.")
  }
}

async function verifyRegistration(
  deps: InstallerDeps,
  id: string,
  expectedContent: string,
): Promise<{ registered: boolean; verified: boolean; actualContent?: string }> {
  const listed = await deps.registrar.list()
  const found = listed.find((skill) => skill.id === id)
  if (!found) return { registered: false, verified: false }
  return { registered: true, verified: sameContent(found.content, expectedContent), actualContent: found.content }
}

async function cleanupBackups(deps: InstallerDeps, id: string) {
  const { readdir } = await import("node:fs/promises")
  try {
    const entries = (await readdir(deps.registry.backupDir))
      .filter((name) => name.startsWith(`${id}-`))
      .sort()
      .reverse()
    for (const old of entries.slice(5)) {
      await rm(path.join(deps.registry.backupDir, old), { recursive: true, force: true }).catch(() => undefined)
    }
  } catch {
    // No backups yet.
  }
}

function blocked(preview: Preview): SecurityReport {
  return preview.security
}

export async function installPreview(deps: InstallerDeps, preview: Preview, options: InstallOptions): Promise<InstallResult> {
  return deps.lock.run(async () => {
    const messages: string[] = []
    if (blocked(preview).status === "blocked") {
      throw new SkillManagerError("UNSAFE_CONTENT", "The skill was blocked by the security scanner.", {
        hint: "Blocking findings cannot be overridden by the manager. Review the files and install manually if you trust them.",
        details: blocked(preview).findings.filter((finding) => finding.severity === "block"),
      })
    }
    if (preview.security.status === "warnings" && !options.allowWarnings) {
      throw new SkillManagerError("UNSAFE_CONTENT", "The skill has security warnings and requires explicit approval.", {
        hint: "Inspect the findings, then call skill_install with allowWarnings: true if you accept them.",
        details: preview.security.findings.filter((finding) => finding.severity !== "info").slice(0, 20),
      })
    }

    const id = sanitizeSkillId(options.id ?? preview.suggestedId)
    const target = safeSkillDirectory(deps.skillsRoot, id)
    const hash = hashFiles(preview.files)
    const existing = deps.registry.get(id)
    const targetExists = await exists(target)
    const overwrite = options.overwrite ?? "error"

    if (existing && existing.hash === hash && targetExists) {
      messages.push(`Skill ${id} is already installed with identical content.`)
      const current = await verifyRegistration(deps, id, preview.parsed.body)
      if (!current.registered) {
        const skill = localSkill(preview, id, target)
        deps.registrar.add(skill)
        await deps.registrar.reload()
      }
      const verified = await verifyRegistration(deps, id, preview.parsed.body)
      if (!verified.registered) {
        throw new SkillManagerError("VERIFICATION_FAILED", `Skill ${id} is on disk but not registered.`, {
          hint: "Run skill_list and check OpenCode logs.",
        })
      }
      await deps.log.flush()
      return {
        ok: true,
        status: "already-installed",
        id,
        path: path.join(target, "SKILL.md"),
        files: preview.files.map((file) => file.path),
        registered: verified.registered,
        verified: verified.verified,
        advertised: advertised(preview),
        availableIn: "next model step",
        security: preview.security,
        messages,
      }
    }

    if (targetExists) {
      if (!existing && overwrite !== "replace-unmanaged") {
        throw new SkillManagerError("CONFLICT", `A skill directory already exists at .opencode/skills/${id}.`, {
          hint: "It was not installed by skill-manager. Use overwrite: 'replace-unmanaged' only if you reviewed it and want to replace it.",
          details: { id, path: target },
        })
      }
      if (overwrite === "error") {
        throw new SkillManagerError("CONFLICT", `Skill ${id} is already installed from a different version.`, {
          hint: "Use overwrite: 'replace' to update it. A backup will be created.",
          details: { id, installedSource: existing?.source.url, newSource: preview.source.url },
        })
      }
    }

    await options.confirm()
    const now = new Date().toISOString()
    const staging = path.join(deps.stateDir, "tmp", randomUUID())
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const backup = path.join(deps.registry.backupDir, `${id}-${stamp}`)
    let movedAside = false
    let stagingMoved = false

    try {
      messages.push(`Writing ${preview.files.length} file(s) to staging.`)
      await writeStaging(preview, staging)

      await mkdir(deps.skillsRoot, { recursive: true })
      if (targetExists) {
        messages.push(`Backing up existing skill to ${backup}.`)
        await moveAside(target, backup)
        movedAside = true
      }
      await retryFs(() => rename(staging, target))
      stagingMoved = true
      messages.push(`Installed to .opencode/skills/${id}.`)

      const skill = localSkill(preview, id, target)
      deps.registrar.add(skill)
      messages.push("Registered through ctx.skill.transform editor.add().")
      await deps.registrar.reload()
      messages.push("Reloaded the skill registry.")

      const verification = await verifyRegistration(deps, id, preview.parsed.body)
      if (!verification.registered) {
        throw new SkillManagerError("VERIFICATION_FAILED", `Skill ${id} was written but is not visible in ctx.skill.list().`, {
          hint: "Check agent skill permissions and the OpenCode server log.",
          details: { listed: (await deps.registrar.list()).map((item) => item.id) },
        })
      }
      if (!verification.verified) {
        throw new SkillManagerError(
          "VERIFICATION_FAILED",
          `Skill ${id} is registered, but the registered content differs from the installed file.`,
          { details: { expectedLength: preview.parsed.body.length, actualLength: verification.actualContent?.length ?? 0 } },
        )
      }

      const entry = existing
        ? { ...entryFor(preview, id, now), installedAt: existing.installedAt, updatedAt: now }
        : entryFor(preview, id, now)
      await deps.registry.set(entry)
      await cleanupBackups(deps, id)
      messages.push("Verified in ctx.skill.list(); the skill is available to the next model step.")

      return {
        ok: true,
        status: existing ? "updated" : "installed",
        id,
        path: path.join(target, "SKILL.md"),
        files: preview.files.map((file) => file.path),
        registered: true,
        verified: true,
        advertised: advertised(preview),
        availableIn: "next model step",
        security: preview.security,
        messages,
        ...(movedAside ? { backup } : {}),
      }
    } catch (error) {
      deps.log.error("install-failed", { id, error: (error as Error).message })
      deps.registrar.remove(id)
      await deps.registrar.reload().catch(() => undefined)
      if (stagingMoved) {
        await rm(target, { recursive: true, force: true }).catch(() => undefined)
      }
      if (movedAside) {
        await restore(backup, target).catch((restoreError) => {
          deps.log.error("restore-failed", { id, backup, error: (restoreError as Error).message })
        })
      }
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  })
}

export async function uninstallSkill(
  deps: InstallerDeps,
  id: string,
  options: UninstallOptions,
): Promise<UninstallResult> {
  return deps.lock.run(async () => {
    const messages: string[] = []
    const normalized = sanitizeSkillId(id)
    const target = safeSkillDirectory(deps.skillsRoot, normalized)
    const entry = deps.registry.get(normalized)
    const targetExists = await exists(target)
    if (!entry && targetExists && options.force !== "unmanaged") {
      throw new SkillManagerError("NOT_MANAGED", `Skill ${normalized} is not managed by skill-manager.`, {
        hint: "Use force: 'unmanaged' only if you understand it will be removed.",
      })
    }
    if (!entry && !targetExists) {
      throw new SkillManagerError("NOT_FOUND", `Skill ${normalized} is not installed in this project.`)
    }

    await options.confirm()
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const backup = path.join(deps.registry.backupDir, `${normalized}-removed-${stamp}`)
    let movedAside = false
    let previousContent = ""
    let previousName = normalized
    let previousDescription: string | undefined
    let previousAutoinvoke: boolean | undefined
    try {
      if (targetExists) {
        try {
          const text = await readFile(path.join(target, "SKILL.md"), "utf8")
          const { parsed } = parseSkillDocument("SKILL.md", text)
          previousContent = parsed.body
          previousName = parsed.name
          previousDescription = parsed.description
          previousAutoinvoke = parsed.autoinvoke
        } catch {
          // The directory may not contain a readable SKILL.md; removal still uses the registry.
        }
        await moveAside(target, backup)
        movedAside = true
        messages.push(`Moved skill files to ${backup}.`)
      }
      deps.registrar.remove(normalized)
      await deps.registrar.reload()
      messages.push("Reloaded the skill registry.")
      // The config skill plugin also watches .opencode/skills and rescans after a
      // short debounce. Give it a chance to drop its stale transform before we
      // decide whether another source still provides this id.
      await new Promise((resolve) => setTimeout(resolve, 350))
      await deps.registrar.reload()
      const listed = await deps.registrar.list()
      const candidate = listed.find((skill) => skill.id === normalized)
      const still =
        candidate && (candidate.path.startsWith("skill://") || (await exists(candidate.path))) ? candidate : undefined
      if (still) {
        messages.push(`Skill ${normalized} is still available from another source: ${still.path}`)
      }
      await deps.registry.remove(normalized)
      if (options.purge && targetExists) {
        await rm(backup, { recursive: true, force: true }).catch(() => undefined)
      }
      return {
        ok: true,
        id: normalized,
        removed: true,
        ...(movedAside && !options.purge ? { backup } : {}),
        ...(still ? { stillAvailableFrom: [still.path] } : {}),
        messages,
      }
    } catch (error) {
      deps.log.error("uninstall-failed", { id: normalized, error: (error as Error).message })
      if (movedAside) {
        await restore(backup, target).catch(() => undefined)
        const entryNow = deps.registry.get(normalized)
        if (entryNow && previousContent) {
          deps.registrar.add({
            id: normalized,
            name: previousName,
            ...(previousDescription ? { description: previousDescription } : {}),
            ...(previousAutoinvoke === undefined ? {} : { autoinvoke: previousAutoinvoke }),
            path: path.join(target, "SKILL.md"),
            content: previousContent,
          })
          await deps.registrar.reload().catch(() => undefined)
        }
      }
      throw error
    }
  })
}
