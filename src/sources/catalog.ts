import { assessCompatibility, assessQuality } from "../assess.ts"
import { downloadJson, downloadText } from "../download.ts"
import { SkillManagerError } from "../errors.ts"
import { parseSkillDocument } from "../frontmatter.ts"
import { makeFile, normalizeText } from "../hash.ts"
import { isSafeRelativePath, sanitizeSkillId } from "../paths.ts"
import type { Candidate, ParsedSkill, SkillBundle, SkillFile, SourceRef } from "../types.ts"
import type { SourceContext } from "./context.ts"

interface CatalogIndexEntry {
  readonly name?: string
  readonly version?: string
  readonly files?: string[]
}

interface CatalogIndex {
  readonly skills?: CatalogIndexEntry[]
}

export interface CatalogLocation {
  readonly base: string
  readonly name?: string
}

function baseUrl(value: string): string {
  return value.endsWith("/") ? value : `${value}/`
}

function sourceRef(base: string, name?: string): SourceRef {
  return {
    type: "catalog",
    url: base,
    ...(name ? { path: name, slug: name } : {}),
  }
}

export function parseCatalogUrl(value: string): CatalogLocation | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (!/^https?:$/.test(url.protocol)) return undefined
  const path = url.pathname
  if (path.endsWith("/index.json")) {
    return { base: new URL("./", url).href }
  }
  if (path.endsWith("/")) {
    return { base: url.href }
  }
  return undefined
}

export async function fetchCatalogIndex(ctx: SourceContext, location: CatalogLocation): Promise<CatalogIndex> {
  const key = `catalog:index:${location.base}`.toLowerCase()
  const cached = ctx.cache.get<CatalogIndex>(key)
  if (cached) return cached
  const data = await downloadJson<CatalogIndex>(`${baseUrl(location.base)}index.json`, {
    ...ctx.download,
    headers: { accept: "application/json", ...ctx.download.headers },
  })
  if (!Array.isArray(data.skills)) {
    throw new SkillManagerError("INVALID_SOURCE", "HTTP skill catalog has no skills array.", {
      details: { url: `${baseUrl(location.base)}index.json` },
    })
  }
  return ctx.cache.set(key, data, 5 * 60_000)
}

function entryName(entry: CatalogIndexEntry): string | undefined {
  if (typeof entry.name !== "string" || !entry.name) return undefined
  return entry.name
}

export async function listCatalogCandidates(
  ctx: SourceContext,
  location: CatalogLocation,
  query?: string,
): Promise<Candidate[]> {
  const index = await fetchCatalogIndex(ctx, location)
  const base = baseUrl(location.base)
  const entries = (index.skills ?? []).flatMap((entry) => {
    const name = entryName(entry)
    if (!name) return []
    if (!Array.isArray(entry.files) || !entry.files.includes("SKILL.md")) return []
    if (location.name && entry.name !== location.name) return []
    return [{ entry, name }]
  })
  const tokens = query
    ? query
        .toLowerCase()
        .split(/\s+/)
        .filter((token) => token.length >= 3)
    : []
  const ranked = entries
    .map((item) => ({
      ...item,
      score: tokens.reduce((sum, token) => sum + (item.name.toLowerCase().includes(token) ? 1 : 0), 0),
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 20)

  const candidates: Candidate[] = []
  for (const item of ranked) {
    let parsed: ParsedSkill = { name: item.name, body: "", frontmatter: {} }
    try {
      const text = await downloadText(`${base}${encodeURIComponent(item.name)}/SKILL.md`, {
        ...ctx.download,
        headers: { accept: "text/markdown, text/plain, */*", ...ctx.download.headers },
      })
      parsed = parseSkillDocument("SKILL.md", normalizeText(text)).parsed
    } catch (error) {
      ctx.log.debug("catalog-describe-failed", { base, name: item.name, error: (error as Error).message })
    }
    const source = sourceRef(base, item.name)
    const compatibility = assessCompatibility(parsed)
    candidates.push({
      id: sanitizeSkillId(item.name),
      name: parsed.name || item.name,
      ...(parsed.description ? { description: parsed.description } : {}),
      source,
      compatibility,
      quality: assessQuality({ parsed, compatibility }),
    })
  }
  return candidates
}

export async function downloadCatalogSkill(
  ctx: SourceContext,
  location: CatalogLocation,
  name: string,
): Promise<SkillBundle> {
  const base = baseUrl(location.base)
  const index = await fetchCatalogIndex(ctx, location)
  const entry = (index.skills ?? []).find((item) => item.name === name)
  if (!entry) {
    throw new SkillManagerError("NOT_FOUND", `Catalog has no skill named ${name}.`)
  }
  const declared = Array.isArray(entry.files) ? entry.files : []
  if (!declared.includes("SKILL.md") && !declared.includes(`${name}.md`)) {
    throw new SkillManagerError("INVALID_SKILL", `Catalog entry ${name} does not declare SKILL.md or ${name}.md.`)
  }
  const sourceUrl = new URL(base)
  const files: SkillFile[] = []
  for (const file of declared) {
    if (!isSafeRelativePath(file)) {
      throw new SkillManagerError("UNSAFE_PATH", `Unsafe catalog path: ${file}`)
    }
    const target = new URL(`${encodeURIComponent(name)}/${file}`, base)
    if (target.origin !== sourceUrl.origin) {
      throw new SkillManagerError("UNSAFE_PATH", `Catalog file escapes its origin: ${file}`)
    }
    const text = await downloadText(target.href, {
      ...ctx.download,
      headers: { accept: "text/plain, text/markdown, */*", ...ctx.download.headers },
    })
    files.push(makeFile(file, normalizeText(text)))
  }
  let skillFile = files.find((file) => file.path === "SKILL.md")
  if (!skillFile) {
    const fallback = files.find((file) => file.path === `${name}.md`)
    if (!fallback) throw new SkillManagerError("INVALID_SKILL", `Catalog skill ${name} has no entry file.`)
    skillFile = { ...fallback, path: "SKILL.md" }
    files[files.indexOf(fallback)] = skillFile
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  const parsed = parseSkillDocument(skillFile.path, skillFile.content).parsed
  return {
    source: sourceRef(base, name),
    files,
    parsed,
    suggestedId: sanitizeSkillId(parsed.name || name, sanitizeSkillId(name)),
    notes: entry.version ? [`Catalog version: ${entry.version}`] : [],
  }
}
