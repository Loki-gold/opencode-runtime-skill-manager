import { assessCompatibility, assessQuality } from "../assess.ts"
import { SkillManagerError } from "../errors.ts"
import { parseSkillDocument } from "../frontmatter.ts"
import type { Candidate, SkillBundle } from "../types.ts"
import type { SourceContext } from "./context.ts"
import {
  dedupeCandidates,
  githubLocationFromCandidate,
  listGithubCandidates,
  parseGithubShorthand,
  parseGithubUrl,
  resolveGithubBundle,
  searchGithub,
  type GithubLocation,
} from "./github.ts"
import {
  downloadSkillsSh,
  parseSkillsShUrl,
  searchSkillsSh,
  skillsShFromCandidate,
  type SkillsShLocation,
} from "./skills-sh.ts"
import {
  downloadCatalogSkill,
  listCatalogCandidates,
  parseCatalogUrl,
  type CatalogLocation,
} from "./catalog.ts"
import { downloadDirectSkill, isDirectSkillUrl } from "./direct.ts"

export type SourceKind = "auto" | "skills.sh" | "github" | "all"

export interface ResolveOptions {
  readonly path?: string
  readonly ref?: string
  readonly name?: string
  readonly allowSearch?: boolean
}

export type ParsedInput =
  | { readonly type: "github"; readonly location: GithubLocation }
  | { readonly type: "skills.sh"; readonly location: SkillsShLocation }
  | { readonly type: "catalog"; readonly location: CatalogLocation }
  | { readonly type: "direct"; readonly url: string }
  | { readonly type: "query"; readonly query: string }

export function parseInput(input: string): ParsedInput {
  const trimmed = input.trim()
  if (!trimmed) throw new SkillManagerError("INVALID_INPUT", "Source or query is empty.")
  const github = parseGithubUrl(trimmed)
  if (github) return { type: "github", location: github }
  const shorthand = parseGithubShorthand(trimmed)
  if (shorthand) return { type: "github", location: shorthand }
  const skillsSh = parseSkillsShUrl(trimmed)
  if (skillsSh) return { type: "skills.sh", location: skillsSh }
  const catalog = parseCatalogUrl(trimmed)
  if (catalog) return { type: "catalog", location: catalog }
  if (/^https?:\/\//i.test(trimmed)) {
    if (isDirectSkillUrl(trimmed)) return { type: "direct", url: trimmed }
    try {
      const url = new URL(trimmed)
      if (url.pathname.endsWith("/index.json")) return { type: "catalog", location: { base: new URL("./", url).href } }
      if (url.pathname.endsWith("/")) return { type: "direct", url: trimmed }
    } catch {
      // fall through
    }
    throw new SkillManagerError("UNSUPPORTED_SOURCE", `Unsupported URL: ${trimmed}`, {
      hint: "Use a GitHub repository/tree/blob URL, a skills.sh skill URL, a SKILL.md URL, or an OpenCode index.json catalog.",
    })
  }
  if (trimmed.includes("://")) {
    throw new SkillManagerError("UNSUPPORTED_SOURCE", `Unsupported source: ${trimmed}`)
  }
  return { type: "query", query: trimmed }
}

export function sourceLabel(candidate: Candidate): string {
  return `${candidate.source.type}:${candidate.source.repo ?? candidate.source.url}`
}

export async function searchAll(
  ctx: SourceContext,
  query: string,
  source: SourceKind,
  limit: number,
): Promise<Candidate[]> {
  const results: Candidate[] = []
  if (source === "auto" || source === "all" || source === "skills.sh") {
    try {
      results.push(...(await searchSkillsSh(ctx, query, limit)))
    } catch (error) {
      ctx.log.warn("skills-sh-search-failed", { error: (error as Error).message })
      if (source === "skills.sh") throw error
    }
  }
  if (source === "github" || source === "all" || (source === "auto" && results.length < Math.min(limit, 3))) {
    try {
      results.push(...(await searchGithub(ctx, query, limit)))
    } catch (error) {
      ctx.log.warn("github-search-failed", { error: (error as Error).message })
      if (source === "github") throw error
    }
  }
  return dedupeCandidates(results)
    .sort((a, b) => b.quality.score - a.quality.score)
    .slice(0, limit)
}

export async function resolveBundle(ctx: SourceContext, input: string, options: ResolveOptions = {}): Promise<SkillBundle> {
  const parsed = parseInput(input)
  switch (parsed.type) {
    case "github":
      return resolveGithubBundle(ctx, parsed.location, { path: options.path, name: options.name })
    case "skills.sh":
      return downloadSkillsSh(ctx, parsed.location)
    case "catalog": {
      if (options.name) return downloadCatalogSkill(ctx, parsed.location, options.name)
      const candidates = await listCatalogCandidates(ctx, parsed.location)
      if (candidates.length === 1) {
        const name = candidates[0]!.source.slug ?? candidates[0]!.id
        return downloadCatalogSkill(ctx, parsed.location, name)
      }
      throw new SkillManagerError("AMBIGUOUS_SKILL", "Catalog contains multiple skills; specify a name.", {
        details: { candidates: candidates.map((item) => ({ id: item.id, name: item.name })) },
      })
    }
    case "direct":
      return downloadDirectSkill(ctx, parsed.url, options.name)
    case "query": {
      if (!options.allowSearch) {
        throw new SkillManagerError("INVALID_SOURCE", `Not a source URL: ${input}`, {
          hint: "Run skill_search first, then install using an inspectToken or a source URL.",
        })
      }
      const candidates = await searchAll(ctx, parsed.query, "auto", 8)
      if (candidates.length === 0) {
        throw new SkillManagerError("NOT_FOUND", `No skills found for: ${parsed.query}`)
      }
      if (candidates.length > 1) {
        throw new SkillManagerError("AMBIGUOUS_SKILL", "Multiple skills match this query; inspect and choose one.", {
          details: {
            candidates: candidates.map((item) => ({
              id: item.id,
              name: item.name,
              source: item.source.url,
              inspectToken: item.inspectToken,
            })),
          },
        })
      }
      return resolveCandidateBundle(ctx, candidates[0]!)
    }
  }
}

export async function resolveCandidateBundle(ctx: SourceContext, candidate: Candidate): Promise<SkillBundle> {
  if (candidate.source.type === "github") {
    const location = githubLocationFromCandidate(candidate)
    if (!location) throw new SkillManagerError("INVALID_SOURCE", "GitHub candidate has no repository information.")
    return resolveGithubBundle(ctx, location, { path: candidate.source.path, name: candidate.id })
  }
  if (candidate.source.type === "skills.sh") {
    const location = skillsShFromCandidate(candidate)
    if (!location) throw new SkillManagerError("INVALID_SOURCE", "skills.sh candidate has no source information.")
    return downloadSkillsSh(ctx, location)
  }
  if (candidate.source.type === "catalog") {
    const name = candidate.source.slug ?? candidate.source.path
    if (!name) throw new SkillManagerError("INVALID_SOURCE", "Catalog candidate has no skill name.")
    return downloadCatalogSkill(ctx, { base: candidate.source.url }, name)
  }
  if (candidate.files && candidate.files.length > 0) {
    const skillFile = candidate.files.find((file) => file.path === "SKILL.md")
    const parsed = skillFile
      ? parseSkillDocument("SKILL.md", skillFile.content).parsed
      : { name: candidate.name, body: "", frontmatter: {} }
    return {
      source: candidate.source,
      files: candidate.files,
      parsed: {
        ...parsed,
        ...(candidate.description ? { description: candidate.description } : {}),
      },
      suggestedId: candidate.id,
      metrics: candidate.metrics,
      notes: [],
    }
  }
  return downloadDirectSkill(ctx, candidate.source.url, candidate.id)
}

export async function listSourceCandidates(
  ctx: SourceContext,
  input: string,
  options: { path?: string; query?: string } = {},
): Promise<Candidate[]> {
  const parsed = parseInput(input)
  if (parsed.type === "github") {
    const candidates = await listGithubCandidates(ctx, parsed.location, options.query)
    return dedupeCandidates(candidates)
  }
  if (parsed.type === "catalog") {
    return listCatalogCandidates(ctx, parsed.location, options.query)
  }
  if (parsed.type === "skills.sh") {
    const bundle = await downloadSkillsSh(ctx, parsed.location)
    const compatibility = assessCompatibility(bundle.parsed)
    return [
      {
        id: bundle.suggestedId,
        name: bundle.parsed.name,
        ...(bundle.parsed.description ? { description: bundle.parsed.description } : {}),
        source: bundle.source,
        files: bundle.files,
        metrics: bundle.metrics,
        compatibility,
        quality: assessQuality({
          parsed: bundle.parsed,
          files: bundle.files,
          metrics: bundle.metrics,
          compatibility,
        }),
      },
    ]
  }
  if (parsed.type === "direct") {
    const bundle = await downloadDirectSkill(ctx, parsed.url)
    const compatibility = assessCompatibility(bundle.parsed)
    return [
      {
        id: bundle.suggestedId,
        name: bundle.parsed.name,
        ...(bundle.parsed.description ? { description: bundle.parsed.description } : {}),
        source: bundle.source,
        files: bundle.files,
        compatibility,
        quality: assessQuality({ parsed: bundle.parsed, files: bundle.files, compatibility }),
      },
    ]
  }
  throw new SkillManagerError("INVALID_SOURCE", "Search requires a query, not a source URL.")
}
