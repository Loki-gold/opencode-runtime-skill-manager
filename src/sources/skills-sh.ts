import path from "node:path"
import { assessCompatibility, assessQuality } from "../assess.ts"
import { downloadJson } from "../download.ts"
import { SkillManagerError } from "../errors.ts"
import { parseSkillDocument } from "../frontmatter.ts"
import { makeFile, normalizeText } from "../hash.ts"
import { isSafeRelativePath, sanitizeSkillId } from "../paths.ts"
import type { Candidate, ParsedSkill, SkillBundle, SkillFile, SkillMetrics, SourceRef } from "../types.ts"
import type { SourceContext } from "./context.ts"
import { getRepo } from "./github.ts"

const BASE = "https://skills.sh"

interface SkillsShSkill {
  readonly id?: string
  readonly source?: string
  readonly skillId?: string
  readonly name?: string
  readonly installs?: number
  readonly sourceType?: string
}

interface SkillsShSearch {
  readonly skills?: SkillsShSkill[]
  readonly count?: number
}

interface SkillsShDownload {
  readonly files?: { path?: string; contents?: string }[] | null
  readonly id?: string
  readonly source?: string
  readonly slug?: string
  readonly installs?: number
  readonly hash?: string
}

export interface SkillsShLocation {
  readonly owner: string
  readonly repo: string
  readonly slug: string
}

export function parseSkillsShUrl(value: string): SkillsShLocation | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "")
  if (host !== "skills.sh") return undefined
  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    })
  if (segments[0] === "api") return undefined
  if (segments.length < 3) return undefined
  const [owner, repo, slug] = segments
  if (!owner || !repo || !slug) return undefined
  return { owner, repo, slug }
}

function sourceRef(location: SkillsShLocation, slug = location.slug): SourceRef {
  return {
    type: "skills.sh",
    url: `${BASE}/${location.owner}/${location.repo}/${slug}`,
    repo: `${location.owner}/${location.repo}`,
    owner: location.owner,
    slug,
  }
}

function bundleFromDownload(
  location: SkillsShLocation,
  data: SkillsShDownload,
  requestedSlug: string,
): SkillBundle {
  const rawFiles = data.files
  if (!rawFiles || rawFiles.length === 0) {
    throw new SkillManagerError("NOT_FOUND", "skills.sh has no file snapshot for this skill.", {
      hint: "Install it directly from its GitHub repository instead.",
      details: { id: `${location.owner}/${location.repo}/${requestedSlug}` },
    })
  }
  const files: SkillFile[] = []
  for (const raw of rawFiles) {
    if (!raw || typeof raw.path !== "string" || typeof raw.contents !== "string") continue
    const filePath = raw.path.replaceAll("\\", "/").replace(/^\.\/+/, "")
    if (!isSafeRelativePath(filePath)) {
      throw new SkillManagerError("UNSAFE_PATH", `Unsafe path in skills.sh package: ${raw.path}`)
    }
    if (Buffer.byteLength(raw.contents, "utf8") > 5_242_880) {
      throw new SkillManagerError("TOO_LARGE", `File is too large: ${filePath}`)
    }
    files.push(makeFile(filePath, normalizeText(raw.contents)))
  }
  if (files.length === 0) {
    throw new SkillManagerError("NOT_FOUND", "skills.sh returned no usable files for this skill.")
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  let skillFile = files.find((file) => file.path === "SKILL.md")
  if (!skillFile) {
    const fallback = files.find((file) => file.path.toLowerCase() === `${requestedSlug.toLowerCase()}.md`)
    if (!fallback) {
      throw new SkillManagerError("INVALID_SKILL", "skills.sh package does not contain SKILL.md.", {
        details: { files: files.map((file) => file.path).slice(0, 20) },
      })
    }
    skillFile = { ...fallback, path: "SKILL.md" }
    files[files.indexOf(fallback)] = skillFile
  }
  const parsed: ParsedSkill = parseSkillDocument(skillFile.path, skillFile.content).parsed
  const suggestedId = sanitizeSkillId(parsed.name || requestedSlug || location.slug, sanitizeSkillId(location.slug))
  return {
    source: sourceRef(location, requestedSlug),
    files,
    parsed,
    suggestedId,
    metrics:
      data.installs === undefined
        ? undefined
        : { installs: { value: data.installs, source: "skills.sh" as const } },
    notes: data.hash ? [`skills.sh content hash: ${data.hash}`] : [],
  }
}

export async function downloadSkillsSh(
  ctx: SourceContext,
  location: SkillsShLocation,
  slug = location.slug,
): Promise<SkillBundle> {
  const data = await downloadJson<SkillsShDownload>(
    `${BASE}/api/download/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repo)}/${encodeURIComponent(slug)}`,
    {
      ...ctx.download,
      headers: { accept: "application/json", ...ctx.download.headers },
    },
  )
  return bundleFromDownload(location, data, slug)
}

export async function searchSkillsSh(ctx: SourceContext, query: string, limit: number): Promise<Candidate[]> {
  const data = await downloadJson<SkillsShSearch>(
    `${BASE}/api/search?q=${encodeURIComponent(query)}&limit=${Math.min(50, Math.max(1, limit * 2))}`,
    {
      ...ctx.download,
      headers: { accept: "application/json", ...ctx.download.headers },
    },
  )
  const skills = Array.isArray(data.skills) ? data.skills : []
  const candidates: Candidate[] = []
  const seen = new Set<string>()

  for (const skill of skills) {
    if (!skill || typeof skill.id !== "string" || typeof skill.source !== "string") continue
    const parts = skill.source.split("/")
    if (parts.length !== 2 || !parts[0] || !parts[1]) continue
    const slug = typeof skill.skillId === "string" ? skill.skillId : skill.id.split("/").at(-1)
    if (!slug) continue
    const key = skill.id.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const location: SkillsShLocation = { owner: parts[0], repo: parts[1], slug }
    const source = sourceRef(location)
    const name = typeof skill.name === "string" ? skill.name : slug
    const installs = typeof skill.installs === "number" ? skill.installs : undefined
    let metrics: SkillMetrics | undefined = installs === undefined ? undefined : { installs: { value: installs, source: "skills.sh" as const } }
    if (candidates.length < 5) {
      try {
        const repo = await getRepo(ctx, parts[0], parts[1])
        metrics = {
          ...(metrics ?? {}),
          stars: { value: repo.stars, source: "github" as const },
          ...(repo.pushedAt
            ? { repoLastPush: { value: repo.pushedAt, source: "github pushed_at" as const } }
            : {}),
          ...(repo.license ? { license: { value: repo.license, source: "github" as const } } : {}),
          archived: repo.archived,
          fork: repo.fork,
        }
      } catch (error) {
        ctx.log.debug("skills-sh-repo-metadata-failed", { repo: `${parts[0]}/${parts[1]}`, error: (error as Error).message })
      }
    }

    let files: readonly SkillFile[] | undefined
    let parsed: ParsedSkill = { name, body: "", frontmatter: {} }
    if (candidates.length < 6) {
      try {
        const bundle = await downloadSkillsSh(ctx, location, slug)
        files = bundle.files
        parsed = bundle.parsed
      } catch (error) {
        ctx.log.debug("skills-sh-download-failed", { id: skill.id, error: (error as Error).message })
      }
    }
    const compatibility = assessCompatibility(parsed)
    candidates.push({
      id: sanitizeSkillId(parsed.name || slug, sanitizeSkillId(slug)),
      name: parsed.name || name,
      ...(parsed.description ? { description: parsed.description } : {}),
      source,
      ...(files ? { files } : {}),
      ...(metrics ? { metrics } : {}),
      ...(installs !== undefined ? { installs } : {}),
      compatibility,
      quality: assessQuality({ parsed, files, metrics, compatibility }),
    })
    if (candidates.length >= limit) break
  }
  return candidates
}

export function skillsShFromCandidate(candidate: Candidate): SkillsShLocation | undefined {
  if (candidate.source.type !== "skills.sh" || !candidate.source.repo || !candidate.source.slug) return undefined
  const [owner, repo] = candidate.source.repo.split("/")
  if (!owner || !repo) return undefined
  return { owner, repo, slug: candidate.source.slug }
}

export function skillDisplayPath(location: SkillsShLocation): string {
  return path.posix.join(location.owner, location.repo, location.slug)
}


