import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { SkillManagerError } from "./errors.ts"
import type { RegistryData, RegistryEntry, SourceRef } from "./types.ts"

const EMPTY: RegistryData = { version: 1, skills: {} }

function isSource(value: unknown): value is SourceRef {
  if (!value || typeof value !== "object") return false
  const source = value as Record<string, unknown>
  return (
    (source.type === "skills.sh" || source.type === "github" || source.type === "url" || source.type === "catalog") &&
    typeof source.url === "string"
  )
}

function normalizeEntry(id: string, value: unknown): RegistryEntry | undefined {
  if (!value || typeof value !== "object") return undefined
  const entry = value as Record<string, unknown>
  if (entry.id !== id || !isSource(entry.source)) return undefined
  if (typeof entry.hash !== "string" || typeof entry.installedAt !== "string" || typeof entry.updatedAt !== "string") {
    return undefined
  }
  const files = Array.isArray(entry.files)
    ? entry.files.flatMap((item) => {
        if (!item || typeof item !== "object") return []
        const file = item as Record<string, unknown>
        if (typeof file.path !== "string" || typeof file.sha256 !== "string" || typeof file.bytes !== "number") return []
        return [{ path: file.path, bytes: file.bytes, sha256: file.sha256 }]
      })
    : []
  const security =
    entry.security && typeof entry.security === "object"
      ? (entry.security as Record<string, unknown>)
      : { status: "warnings", warnings: 0 }
  return {
    id,
    source: entry.source,
    hash: entry.hash,
    installedAt: entry.installedAt,
    updatedAt: entry.updatedAt,
    files,
    security: {
      status: security.status === "clean" || security.status === "blocked" ? security.status : "warnings",
      warnings: typeof security.warnings === "number" ? security.warnings : 0,
    },
    installedBy: typeof entry.installedBy === "string" ? entry.installedBy : "unknown",
  }
}

export class RegistryStore {
  readonly stateDir: string
  readonly file: string
  readonly backupDir: string
  private data: RegistryData = EMPTY
  private loaded = false
  private corruptFile?: string

  constructor(stateDir: string) {
    this.stateDir = stateDir
    this.file = path.join(stateDir, "registry.json")
    this.backupDir = path.join(stateDir, "backups")
  }

  async load(): Promise<RegistryData> {
    if (this.loaded) return this.data
    this.loaded = true
    try {
      const text = await readFile(this.file, "utf8")
      const raw: unknown = JSON.parse(text.replace(/^\uFEFF/, ""))
      if (!raw || typeof raw !== "object") throw new Error("registry root is not an object")
      const record = raw as Record<string, unknown>
      const skills: Record<string, RegistryEntry> = {}
      if (record.skills && typeof record.skills === "object") {
        for (const [id, value] of Object.entries(record.skills as Record<string, unknown>)) {
          const entry = normalizeEntry(id, value)
          if (entry) skills[id] = entry
        }
      }
      this.data = { version: 1, skills }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.corruptFile = path.join(this.stateDir, `registry.corrupt-${Date.now()}.json`)
        await rename(this.file, this.corruptFile).catch(() => undefined)
      }
      this.data = EMPTY
    }
    return this.data
  }

  async save(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true })
    const temp = path.join(this.stateDir, `.registry-${process.pid}-${Date.now()}.tmp`)
    const body = `${JSON.stringify(this.data, null, 2)}\n`
    await writeFile(temp, body, "utf8")
    try {
      await rename(temp, this.file)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw new SkillManagerError("IO_ERROR", `Failed to write registry: ${(error as Error).message}`, {
        cause: error,
      })
    }
  }

  get(id: string): RegistryEntry | undefined {
    return this.data.skills[id]
  }

  entries(): readonly RegistryEntry[] {
    return Object.values(this.data.skills)
  }

  async set(entry: RegistryEntry): Promise<void> {
    this.data = { version: 1, skills: { ...this.data.skills, [entry.id]: entry } }
    await this.save()
  }

  async remove(id: string): Promise<void> {
    if (!this.data.skills[id]) return
    const skills = { ...this.data.skills }
    delete skills[id]
    this.data = { version: 1, skills }
    await this.save()
  }

  corruptPath(): string | undefined {
    return this.corruptFile
  }
}
