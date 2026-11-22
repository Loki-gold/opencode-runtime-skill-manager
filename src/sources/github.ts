import path from "node:path"
import { assessCompatibility, assessQuality } from "../assess.ts"
import { download, downloadJson, type DownloadResult } from "../download.ts"
import { SkillManagerError } from "../errors.ts"
import { parseSkillDocument } from "../frontmatter.ts"
import { makeFile, normalizeText } from "../hash.ts"
import { inferSkillIdFromPath, isInside, isSafeRelativePath, sanitizeSkillId } from "../paths.ts"
import type { Candidate, ParsedSkill, SkillBundle, SkillFile, SkillMetrics, SourceRef } from "../types.ts"
import type { SourceContext } from "./context.ts"

export interface GithubLocation {
  readonly owner: string
  readonly repo: string
  readonly ref?: string
  readonly path?: string
  readonly kind: "repo" | "tree" | "blob" | "raw"
}

export interface GithubRepoInfo {
  readonly owner: string
  readonly repo: string
  readonly defaultBranch: string
  readonly stars: number
  readonly pushedAt?: string
  readonly license?: string
  readonly archived: boolean
  readonly fork: boolean
  readonly htmlUrl: string
}

interface TreeItem {
  readonly path: string
  readonly type: "blob" | "tree" | "commit"
  readonly size?: number
  readonly sha?: string
}

interface Tree {
  readonly ref: string
  readonly items: readonly TreeItem[]
  readonly truncated: boolean
}

const API = "https://api.github.com"
const RAW = "https://raw.githubusercontent.com"

function githubHeaders(ctx: SourceContext, accept = "application/vnd.github+json"): Record<string, string> {
  return {
    accept,
    "x-github-api-version": "2022-11-28",
    ...(ctx.githubToken ? { authorization: `Bearer ${ctx.githubToken}` } : {}),
  }
}

async function api(ctx: SourceContext, endpoint: string): Promise<DownloadResult> {
  const result = await download(`${API}${endpoint}`, {
    ...ctx.download,
    headers: githubHeaders(ctx),
  })
  const remaining = result.headers.get("x-ratelimit-remaining")
  if (remaining !== null && Number(remaining) <= 0) {
    const reset = Number(result.headers.get("x-ratelimit-reset"))
    const when = Number.isFinite(reset) ? new Date(reset * 1_000).toISOString() : "soon"
    ctx.log.warn("github-rate-limit", { remaining: 0, reset: when })
  }
  return result
}

async function apiJson<T>(ctx: SourceContext, endpoint: string): Promise<T> {
  try {
    const result = await api(ctx, endpoint)
    return JSON.parse(result.text.replace(/^\uFEFF/, "")) as T
  } catch (error) {
    if (error instanceof SkillManagerError && error.code === "NETWORK_ERROR") {
      const status = (error.details as { status?: number } | undefined)?.status
      if (status === 404) {
        throw new SkillManagerError("NOT_FOUND", `GitHub resource not found: ${endpoint}`, {
          hint: "Check the owner, repository, ref and path.",
          cause: error,
        })
      }
      if (status === 403 || status === 429) {
        throw new SkillManagerError("RATE_LIMITED", "GitHub API rate limit reached.", {
          hint: ctx.githubToken
            ? "Wait for the limit to reset."
            : "Set GITHUB_TOKEN (or githubTokenEnv) to raise the limit.",
          cause: error,
        })
      }
      if (status === 401) {
        throw new SkillManagerError("INVALID_SOURCE", "GitHub rejected the access token.", { cause: error })
      }
    }
    throw error
  }
}

export function parseGithubUrl(value: string): GithubLocation | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "")
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
  if (host === "github.com") {
    if (segments.length < 2) return undefined
    const [owner, repo, kind, ...rest] = segments
    if (!owner || !repo) return undefined
    const cleanRepo = repo.replace(/\.git$/i, "")
    if (!kind) return { owner, repo: cleanRepo, kind: "repo" }
    if (kind === "tree" && rest.length >= 1) {
      return { owner, repo: cleanRepo, ref: rest[0], path: rest.slice(1).join("/") || undefined, kind: "tree" }
    }
    if (kind === "blob" && rest.length >= 2) {
      return { owner, repo: cleanRepo, ref: rest[0], path: rest.slice(1).join("/"), kind: "blob" }
    }
    if (kind === "raw" && rest.length >= 2) {
      return { owner, repo: cleanRepo, ref: rest[0], path: rest.slice(1).join("/"), kind: "raw" }
    }
    return { owner, repo: cleanRepo, kind: "repo" }
  }
  if (host === "raw.githubusercontent.com" && segments.length >= 4) {
    const [owner, repo, ref, ...rest] = segments
    if (!owner || !repo || !ref || rest.length === 0) return undefined
    return { owner, repo, ref, path: rest.join("/"), kind: "raw" }
  }
  return undefined
}

export function parseGithubShorthand(value: string): GithubLocation | undefined {
  const match = value.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/)
  if (!match) return undefined
  return { owner: match[1]!, repo: match[2]!.replace(/\.git$/i, ""), kind: "repo" }
}

export async function getRepo(ctx: SourceContext, owner: string, repo: string): Promise<GithubRepoInfo> {
  const key = `gh:repo:${owner}/${repo}`.toLowerCase()
  const cached = ctx.cache.get<GithubRepoInfo>(key)
  if (cached) return cached
  const data = await apiJson<Record<string, unknown>>(ctx, `/repos/${owner}/${repo}`)
  const license =
    data.license && typeof data.license === "object"
      ? (data.license as Record<string, unknown>).spdx_id
      : undefined
  const info: GithubRepoInfo = {
    owner,
    repo,
    defaultBranch: typeof data.default_branch === "string" ? data.default_branch : "main",
    stars: typeof data.stargazers_count === "number" ? data.stargazers_count : 0,
    ...(typeof data.pushed_at === "string" ? { pushedAt: data.pushed_at } : {}),
    ...(typeof license === "string" ? { license } : {}),
    archived: data.archived === true,
    fork: data.fork === true,
    htmlUrl: typeof data.html_url === "string" ? data.html_url : `https://github.com/${owner}/${repo}`,
  }
  return ctx.cache.set(key, info, 10 * 60_000)
}

async function getTree(ctx: SourceContext, owner: string, repo: string, ref: string): Promise<Tree> {
  const key = `gh:tree:${owner}/${repo}@${ref}`.toLowerCase()
  const cached = ctx.cache.get<Tree>(key)
  if (cached) return cached
  const data = await apiJson<Record<string, unknown>>(
    ctx,
    `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
  )
  const items = Array.isArray(data.tree)
    ? data.tree.flatMap((item) => {
        if (!item || typeof item !== "object") return []
        const record = item as Record<string, unknown>
        if (typeof record.path !== "string" || typeof record.type !== "string") return []
        if (record.type !== "blob" && record.type !== "tree") return []
        return [
          {
            path: record.path,
            type: record.type as "blob" | "tree",
            ...(typeof record.size === "number" ? { size: record.size } : {}),
            ...(typeof record.sha === "string" ? { sha: record.sha } : {}),
          },
        ]
      })
    : []
  return ctx.cache.set(
    key,
    { ref, items, truncated: data.truncated === true },
    10 * 60_000,
  )
}

async function resolveRef(
  ctx: SourceContext,
  location: GithubLocation,
): Promise<{ ref: string; path?: string; repo: GithubRepoInfo }> {
  const repo = await getRepo(ctx, location.owner, location.repo)
  if (location.kind === "repo" || !location.ref) {
    return { ref: repo.defaultBranch, path: location.path, repo }
  }
  const candidates: { ref: string; path?: string }[] = []
  const parts = (location.path ?? "").split("/").filter(Boolean)
  for (let count = 0; count <= Math.min(3, parts.length); count++) {
    const ref = [location.ref, ...parts.slice(0, count)].join("/")
    const path = parts.slice(count).join("/") || undefined
    candidates.push({ ref, path })
  }
  let lastError: unknown
  for (const candidate of candidates) {
    try {
      await getTree(ctx, location.owner, location.repo, candidate.ref)
      return { ...candidate, repo }
    } catch (error) {
      lastError = error
      if (!(error instanceof SkillManagerError) || error.code !== "NOT_FOUND") throw error
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new SkillManagerError("NOT_FOUND", `Could not resolve GitHub ref for ${location.owner}/${location.repo}`)
}

function encodePath(value: string): string {
  return value
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/")
}

async function fetchBlob(
  ctx: SourceContext,
  owner: string,
  repo: string,
  ref: string,
  filePath: string,
): Promise<string> {
  const url = `${RAW}/${owner}/${repo}/${encodePath(ref)}/${encodePath(filePath)}`
  try {
    return (
      await download(url, {
        ...ctx.download,
        headers: { accept: "text/plain", ...(ctx.githubToken ? { authorization: `Bearer ${ctx.githubToken}` } : {}) },
      })
    ).text
  } catch (error) {
    if (!ctx.githubToken) throw error
    const result = await download(
      `${API}/repos/${owner}/${repo}/contents/${encodePath(filePath)}?ref=${encodeURIComponent(ref)}`,
      { ...ctx.download, headers: githubHeaders(ctx, "application/vnd.github.raw") },
    )
    return result.text
  }
}

function metricsFromRepo(repo: GithubRepoInfo): SkillMetrics {
  return {
    stars: { value: repo.stars, source: "github" },
    ...(repo.pushedAt ? { repoLastPush: { value: repo.pushedAt, source: "github pushed_at" as const } } : {}),
    ...(repo.license ? { license: { value: repo.license, source: "github" as const } } : {}),
    archived: repo.archived,
    fork: repo.fork,
  }
}

function skillDirsFromTree(tree: Tree, subpath?: string): { path: string; skillFile: string }[] {
  const prefix = subpath ? subpath.replace(/^\/+|\/+$/g, "") : ""
  const byDir = new Map<string, string>()
  for (const item of tree.items) {
    if (item.type !== "blob") continue
    const normalized = item.path.replaceAll("\\", "/")
    if (path.posix.basename(normalized) !== "SKILL.md") continue
    const dir = path.posix.dirname(normalized)
    if (dir === ".") continue
    if (dir.split("/").some((segment) => segment.startsWith(".") || segment === "node_modules")) continue
    if (dir.split("/").length > 6) continue
    if (prefix && dir !== prefix && !dir.startsWith(`${prefix}/`)) continue
    byDir.set(dir, normalized)
  }
  return [...byDir.entries()].map(([dir, skillFile]) => ({ path: dir, skillFile }))
}

function isRepoRootSkill(tree: Tree, subpath?: string): boolean {
  if (subpath) return false
  return tree.items.some((item) => item.type === "blob" && item.path === "SKILL.md")
}

function allowedRootFile(value: string): boolean {
  const normalized = value.replaceAll("\\", "/")
  if (normalized === "SKILL.md") return true
  if (!normalized.includes("/")) return normalized.toLowerCase().endsWith(".md")
  const top = normalized.split("/")[0]?.toLowerCase() ?? ""
  if (top.startsWith(".") || ["node_modules", "src", "dist", "build", "packages"].includes(top)) return false
  return ["references", "reference", "scripts", "assets", "templates", "examples", "docs", "resources"].includes(top)
}

function selectedBlobs(tree: Tree, skillDir: string, repoRootSkill: boolean): readonly TreeItem[] {
  return tree.items.filter((item) => {
    if (item.type !== "blob") return false
    const normalized = item.path.replaceAll("\\", "/")
    if (normalized.split("/").some((segment) => segment === "node_modules" || segment === ".git")) return false
    if (repoRootSkill) return allowedRootFile(normalized)
    if (!normalized.startsWith(`${skillDir}/`)) return false
    const relative = normalized.slice(skillDir.length + 1)
    if (relative.split("/").some((segment) => segment.startsWith("."))) return false
    return true
  })
}

async function buildBundle(
  ctx: SourceContext,
  repo: GithubRepoInfo,
  ref: string,
  skillDir: string,
  repoRootSkill: boolean,
  tree: Tree,
): Promise<SkillBundle> {
  const blobs = selectedBlobs(tree, skillDir, repoRootSkill)
  if (blobs.length === 0) {
    throw new SkillManagerError("NOT_FOUND", `No files found for GitHub skill at ${skillDir || "<repo root>"}`)
  }
  if (blobs.length > ctx.limits.maxFiles) {
    throw new SkillManagerError("TOO_MANY_FILES", `Skill has ${blobs.length} files, limit is ${ctx.limits.maxFiles}.`)
  }
  const total = blobs.reduce((sum, item) => sum + (item.size ?? 0), 0)
  if (total > ctx.limits.maxTotalBytes) {
    throw new SkillManagerError("TOO_LARGE", `Skill is about ${total} bytes, limit is ${ctx.limits.maxTotalBytes}.`, {
      hint: "Choose a smaller skill directory or a direct SKILL.md link.",
    })
  }
  const files: SkillFile[] = []
  let cursor = 0
  const workers = Array.from({ length: Math.min(6, blobs.length) }, async () => {
    while (cursor < blobs.length) {
      const blob = blobs[cursor++]
      if (!blob) continue
      const relative = repoRootSkill ? blob.path : blob.path.slice(skillDir.length + 1)
      if (!isSafeRelativePath(relative)) {
        throw new SkillManagerError("UNSAFE_PATH", `Unsafe GitHub path: ${blob.path}`)
      }
      if ((blob.size ?? 0) > ctx.limits.maxFileBytes) {
        throw new SkillManagerError("TOO_LARGE", `File ${relative} exceeds the per-file limit.`)
      }
      const text = await fetchBlob(ctx, repo.owner, repo.repo, ref, blob.path)
      const content = normalizeText(text)
      files.push(makeFile(relative, content))
    }
  })
  await Promise.all(workers)
  files.sort((a, b) => a.path.localeCompare(b.path))

  let skillFile = files.find((file) => file.path === "SKILL.md")
  if (!skillFile) {
    const fallbackName = `${path.posix.basename(skillDir)}.md`
    const fallback = files.find((file) => file.path === fallbackName)
    if (!fallback) {
      throw new SkillManagerError("INVALID_SKILL", "GitHub skill does not contain SKILL.md at its root.", {
        details: { files: files.map((file) => file.path).slice(0, 20) },
      })
    }
    skillFile = { ...fallback, path: "SKILL.md" }
    const index = files.indexOf(fallback)
    files[index] = skillFile
  }

  const parsedResult = parseSkillDocument(skillFile.path, skillFile.content)
  const parsed = parsedResult.parsed
  const suggestedId = sanitizeSkillId(
    parsed.name || path.posix.basename(skillDir) || repo.repo,
    sanitizeSkillId(repo.repo),
  )
  const notes: string[] = []
  if (tree.truncated) notes.push("GitHub tree response was truncated; some supporting files may be missing.")
  if (repoRootSkill) notes.push("Skill lives at the repository root; only skill files and known resource directories were included.")
  const source: SourceRef = {
    type: "github",
    url: repoRootSkill
      ? `https://github.com/${repo.owner}/${repo.repo}`
      : `https://github.com/${repo.owner}/${repo.repo}/tree/${ref}/${skillDir}`,
    repo: `${repo.owner}/${repo.repo}`,
    ref,
    ...(repoRootSkill ? {} : { path: skillDir }),
  }
  return {
    source,
    files,
    parsed,
    suggestedId,
    metrics: metricsFromRepo(repo),
    notes,
  }
}

async function describeSkill(
  ctx: SourceContext,
  repo: GithubRepoInfo,
  ref: string,
  skillFile: string,
  dir: string,
): Promise<{ parsed: ParsedSkill; text: string }> {
  const text = normalizeText(await fetchBlob(ctx, repo.owner, repo.repo, ref, skillFile))
  return { parsed: parseSkillDocument(skillFile, text).parsed, text }
}

export async function listGithubCandidates(
  ctx: SourceContext,
  location: GithubLocation,
  query?: string,
): Promise<Candidate[]> {
  const resolved = await resolveRef(ctx, location)
  const tree = await getTree(ctx, location.owner, location.repo, resolved.ref)
  const repo = resolved.repo

  if (location.kind === "blob" || location.kind === "raw") {
    const filePath = resolved.path
    if (!filePath) throw new SkillManagerError("INVALID_SOURCE", "GitHub blob URL has no file path.")
    const skillDir = path.posix.dirname(filePath) === "." ? "" : path.posix.dirname(filePath)
    const bundle = await buildBundle(ctx, repo, resolved.ref, skillDir, !skillDir && isRepoRootSkill(tree), tree)
    return [candidateFromBundle(bundle)]
  }

  const dirs = skillDirsFromTree(tree, resolved.path)
  const rootSkill = isRepoRootSkill(tree, resolved.path)
  if (dirs.length === 0 && !rootSkill) {
    throw new SkillManagerError("NOT_FOUND", "No SKILL.md found in this GitHub repository or directory.", {
      hint: "Provide a direct SKILL.md URL or a path to a skill directory.",
    })
  }
  if (dirs.length > 0 && rootSkill) {
    dirs.unshift({ path: "", skillFile: "SKILL.md" })
  }
  const tokens = query
    ? query
        .toLowerCase()
        .split(/\s+/)
        .filter((token) => token.length >= 3)
    : []
  const ranked = dirs
    .map((dir) => {
      const haystack = dir.path.toLowerCase()
      const score = tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0)
      return { ...dir, score }
    })
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 10)

  const candidates: Candidate[] = []
  for (const dir of ranked) {
    const repoRootSkill = dir.path === ""
    const skillFile = dir.skillFile
    let parsed: ParsedSkill
    let compatibility
    try {
      const described = await describeSkill(ctx, repo, resolved.ref, skillFile, dir.path)
      parsed = described.parsed
      compatibility = assessCompatibility(parsed)
    } catch (error) {
      ctx.log.warn("github-describe-failed", { repo: repo.htmlUrl, path: skillFile, error: (error as Error).message })
      compatibility = { status: "unknown" as const, notes: ["Could not download SKILL.md for preview."] }
      parsed = { name: dir.path || repo.repo, body: "", frontmatter: {} }
    }
    const metrics = metricsFromRepo(repo)
    const source: SourceRef = {
      type: "github",
      url: repoRootSkill
        ? `https://github.com/${repo.owner}/${repo.repo}`
        : `https://github.com/${repo.owner}/${repo.repo}/tree/${resolved.ref}/${dir.path}`,
      repo: `${repo.owner}/${repo.repo}`,
      ref: resolved.ref,
      ...(repoRootSkill ? {} : { path: dir.path }),
    }
    candidates.push({
      id: sanitizeSkillId(parsed.name || path.posix.basename(dir.path) || repo.repo),
      name: parsed.name || path.posix.basename(dir.path) || repo.repo,
      ...(parsed.description ? { description: parsed.description } : {}),
      source,
      metrics,
      compatibility,
      quality: assessQuality({ parsed, metrics, compatibility }),
    })
  }
  return candidates
}

function candidateFromBundle(bundle: SkillBundle): Candidate {
  const compatibility = assessCompatibility(bundle.parsed)
  return {
    id: bundle.suggestedId,
    name: bundle.parsed.name,
    ...(bundle.parsed.description ? { description: bundle.parsed.description } : {}),
    source: bundle.source,
    files: bundle.files,
    metrics: bundle.metrics,
    compatibility,
    quality: assessQuality({ parsed: bundle.parsed, files: bundle.files, metrics: bundle.metrics, compatibility }),
  }
}

export async function resolveGithubBundle(
  ctx: SourceContext,
  location: GithubLocation,
  options: { path?: string; name?: string } = {},
): Promise<SkillBundle> {
  const resolved = await resolveRef(ctx, location)
  const tree = await getTree(ctx, location.owner, location.repo, resolved.ref)
  const repo = resolved.repo
  let skillDir = options.path ?? resolved.path
  if (location.kind === "blob" || location.kind === "raw") {
    if (!resolved.path) throw new SkillManagerError("INVALID_SOURCE", "GitHub blob URL has no file path.")
    skillDir = path.posix.dirname(resolved.path)
    if (skillDir === ".") skillDir = ""
  }
  if (skillDir && path.posix.basename(skillDir) === "SKILL.md") skillDir = path.posix.dirname(skillDir)
  const allDirs = skillDirsFromTree(tree)
  const repoRootSkill = !skillDir && isRepoRootSkill(tree)
  if (!skillDir && !repoRootSkill) {
    if (allDirs.length === 0) {
      throw new SkillManagerError("NOT_FOUND", "No SKILL.md found in this GitHub repository.")
    }
    if (allDirs.length > 1) {
      throw new SkillManagerError("AMBIGUOUS_SKILL", "This repository contains multiple skills; specify path.", {
        details: { candidates: allDirs.slice(0, 20).map((dir) => dir.path) },
      })
    }
    skillDir = allDirs[0]!.path
  }
  if (skillDir && !allDirs.some((dir) => dir.path === skillDir)) {
    throw new SkillManagerError("NOT_FOUND", `No SKILL.md at GitHub path: ${skillDir}`)
  }
  const bundle = await buildBundle(ctx, repo, resolved.ref, skillDir ?? "", repoRootSkill, tree)
  return options.name ? { ...bundle, suggestedId: sanitizeSkillId(options.name) } : bundle
}

export async function searchGithub(ctx: SourceContext, query: string, limit: number): Promise<Candidate[]> {
  const trimmed = query.trim()
  if (!trimmed) return []
  const candidates: Candidate[] = []
  const seen = new Set<string>()

  if (ctx.githubToken) {
    try {
      const data = await apiJson<Record<string, unknown>>(
        ctx,
        `/search/code?q=${encodeURIComponent(`filename:SKILL.md ${trimmed}`)}&per_page=${Math.min(10, limit)}`,
      )
      const items = Array.isArray(data.items) ? data.items : []
      for (const item of items.slice(0, 5)) {
        if (!item || typeof item !== "object") continue
        const record = item as Record<string, unknown>
        const repoRecord = record.repository as Record<string, unknown> | undefined
        const ownerRecord = repoRecord?.owner as Record<string, unknown> | undefined
        const owner = typeof ownerRecord?.login === "string" ? ownerRecord.login : undefined
        const repo = typeof repoRecord?.name === "string" ? repoRecord.name : undefined
        const filePath = typeof record.path === "string" ? record.path : undefined
        if (!owner || !repo || !filePath) continue
        const key = `${owner}/${repo}/${filePath}`.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        try {
          const repoInfo = await getRepo(ctx, owner, repo)
          const described = await describeSkill(ctx, repoInfo, repoInfo.defaultBranch, filePath, path.posix.dirname(filePath))
          const source: SourceRef = {
            type: "github",
            url: `https://github.com/${owner}/${repo}/blob/${repoInfo.defaultBranch}/${filePath}`,
            repo: `${owner}/${repo}`,
            ref: repoInfo.defaultBranch,
            path: path.posix.dirname(filePath),
          }
          const compatibility = assessCompatibility(described.parsed)
          candidates.push({
            id: sanitizeSkillId(described.parsed.name || path.posix.basename(path.posix.dirname(filePath))),
            name: described.parsed.name,
            ...(described.parsed.description ? { description: described.parsed.description } : {}),
            source,
            metrics: metricsFromRepo(repoInfo),
            compatibility,
            quality: assessQuality({ parsed: described.parsed, metrics: metricsFromRepo(repoInfo), compatibility }),
          })
        } catch (error) {
          ctx.log.debug("github-code-search-item-failed", { repo: `${owner}/${repo}`, path: filePath, error: (error as Error).message })
        }
      }
    } catch (error) {
      ctx.log.warn("github-code-search-failed", { error: (error as Error).message })
    }
  }

  if (candidates.length < limit) {
    const tokens = trimmed
      .toLowerCase()
      .split(/\s+/)
      .filter((token) => token.length >= 3)
    const baseQuery = tokens.length > 1 ? tokens.slice(0, 2).join(" ") : trimmed
    const repoQueries = [
      `${baseQuery} topic:agent-skills`,
      `${baseQuery} topic:claude-skills`,
      `${baseQuery} skill in:name`,
    ]
    const scanned = new Set<string>()
    for (const repoQuery of repoQueries) {
      if (candidates.length >= limit) break
      let data: Record<string, unknown>
      try {
        data = await apiJson<Record<string, unknown>>(
          ctx,
          `/search/repositories?q=${encodeURIComponent(repoQuery)}&sort=stars&order=desc&per_page=5`,
        )
      } catch (error) {
        ctx.log.debug("github-repo-search-query-failed", { query: repoQuery, error: (error as Error).message })
        continue
      }
      const items = Array.isArray(data.items) ? data.items : []
      for (const item of items.slice(0, 4)) {
        if (candidates.length >= limit) break
        if (!item || typeof item !== "object") continue
        const record = item as Record<string, unknown>
        const fullName = typeof record.full_name === "string" ? record.full_name : undefined
        if (!fullName) continue
        if (scanned.has(fullName.toLowerCase())) continue
        scanned.add(fullName.toLowerCase())
        const [owner, repo] = fullName.split("/")
        if (!owner || !repo) continue
        try {
          const repoInfo = await getRepo(ctx, owner, repo)
          const tree = await getTree(ctx, owner, repo, repoInfo.defaultBranch)
          const dirs = skillDirsFromTree(tree)
            .map((dir) => ({
              ...dir,
              score: tokens.reduce((sum, token) => sum + (dir.path.toLowerCase().includes(token) ? 1 : 0), 0),
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 2)
          for (const dir of dirs) {
            const key = `${owner}/${repo}/${dir.path}`.toLowerCase()
            if (seen.has(key)) continue
            seen.add(key)
            const described = await describeSkill(ctx, repoInfo, repoInfo.defaultBranch, dir.skillFile, dir.path)
            const compatibility = assessCompatibility(described.parsed)
            candidates.push({
              id: sanitizeSkillId(described.parsed.name || path.posix.basename(dir.path)),
              name: described.parsed.name,
              ...(described.parsed.description ? { description: described.parsed.description } : {}),
              source: {
                type: "github",
                url: `https://github.com/${owner}/${repo}/tree/${repoInfo.defaultBranch}/${dir.path}`,
                repo: `${owner}/${repo}`,
                ref: repoInfo.defaultBranch,
                path: dir.path,
              },
              metrics: metricsFromRepo(repoInfo),
              compatibility,
              quality: assessQuality({ parsed: described.parsed, metrics: metricsFromRepo(repoInfo), compatibility }),
            })
          }
        } catch (error) {
          ctx.log.debug("github-repo-search-item-failed", { repo: fullName, error: (error as Error).message })
        }
      }
    }
  }

  return dedupeCandidates(candidates).slice(0, limit)
}

export function dedupeCandidates(candidates: readonly Candidate[]): Candidate[] {
  const seen = new Set<string>()
  const result: Candidate[] = []
  for (const candidate of candidates) {
    const key = `${candidate.source.type}:${candidate.source.repo ?? candidate.source.url}:${candidate.source.path ?? ""}:${candidate.id}`.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(candidate)
  }
  return result
}

export function githubLocationFromCandidate(candidate: Candidate): GithubLocation | undefined {
  if (candidate.source.type !== "github" || !candidate.source.repo) return undefined
  const [owner, repo] = candidate.source.repo.split("/")
  if (!owner || !repo) return undefined
  return {
    owner,
    repo,
    ref: candidate.source.ref,
    path: candidate.source.path,
    kind: candidate.source.path ? "tree" : "repo",
  }
}


