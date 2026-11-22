import path from "node:path"
import { SkillManagerError } from "./errors.ts"

const RESERVED_WINDOWS = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
])

export const MAX_PATH_DEPTH = 12
export const MAX_RELATIVE_PATH_LENGTH = 240

export function isValidSkillId(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 64
}

export function sanitizeSkillId(value: string, fallback = "skill"): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 64)
    .replace(/-+$/g, "")
  return normalized || fallback
}

export function normalizeRelPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\/+/, "")
}

export function isSafeRelativePath(value: string): boolean {
  if (!value || value.length > MAX_RELATIVE_PATH_LENGTH) return false
  if (value.includes("\\") || value.includes("\0")) return false
  if (value.includes("?") || value.includes("#")) return false
  if (/^[a-zA-Z]:/.test(value)) return false
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return false
  if (URL.canParse(value)) return false
  const segments = value.split("/")
  if (segments.length > MAX_PATH_DEPTH) return false
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") return false
    if (/[<>:"|*]/.test(segment)) return false
    if (/[. ]$/.test(segment)) return false
    if (/[\u0000-\u001f]/.test(segment)) return false
    const base = segment.split(".")[0]?.toLowerCase() ?? ""
    if (RESERVED_WINDOWS.has(base)) return false
  }
  return true
}

export function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

export function safeResolve(root: string, relative: string): string {
  if (!isSafeRelativePath(relative)) {
    throw new SkillManagerError("UNSAFE_PATH", `Unsafe file path in skill: ${relative}`, {
      hint: "Skills may only contain relative paths without '..', drive letters, backslashes or reserved Windows names.",
    })
  }
  const target = path.resolve(root, ...relative.split("/"))
  if (!isInside(root, target) || target === path.resolve(root)) {
    throw new SkillManagerError("UNSAFE_PATH", `File path escapes the skill directory: ${relative}`)
  }
  return target
}

export function safeSkillDirectory(skillsRoot: string, id: string): string {
  if (!isValidSkillId(id)) {
    throw new SkillManagerError("INVALID_INPUT", `Invalid skill id: ${id}`, {
      hint: "Use a lowercase kebab-case id of 1-64 characters.",
    })
  }
  const target = path.resolve(skillsRoot, id)
  if (!isInside(skillsRoot, target) || target === path.resolve(skillsRoot)) {
    throw new SkillManagerError("UNSAFE_PATH", `Skill id escapes the skills directory: ${id}`)
  }
  return target
}

export function uniqueSkillId(base: string, taken: ReadonlySet<string>): string {
  const initial = sanitizeSkillId(base)
  if (!taken.has(initial)) return initial
  for (let index = 2; index < 1_000; index++) {
    const candidate = sanitizeSkillId(`${initial}-${index}`)
    if (!taken.has(candidate)) return candidate
  }
  throw new SkillManagerError("CONFLICT", `Could not allocate a unique skill id for ${base}`)
}

export function inferSkillIdFromPath(value: string): string {
  const normalized = normalizeRelPath(value).replace(/\/+$/g, "")
  const segments = normalized.split("/").filter(Boolean)
  const last = segments.at(-1) ?? "skill"
  if (last.toLowerCase() === "skill.md") {
    return segments.at(-2) ?? last.replace(/\.md$/i, "")
  }
  if (last.toLowerCase().endsWith(".md")) {
    return last.replace(/\.md$/i, "")
  }
  return last
}

export function extensionOf(value: string): string {
  const base = value.split("/").at(-1) ?? value
  const index = base.lastIndexOf(".")
  return index === -1 ? "" : base.slice(index).toLowerCase()
}
