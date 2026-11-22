import { assessCompatibility } from "../assess.ts"
import { downloadText } from "../download.ts"
import { SkillManagerError } from "../errors.ts"
import { parseSkillDocument } from "../frontmatter.ts"
import { makeFile, normalizeText } from "../hash.ts"
import { sanitizeSkillId } from "../paths.ts"
import type { SkillBundle, SourceRef } from "../types.ts"
import type { SourceContext } from "./context.ts"

export function looksLikeMarkdown(value: string, url: string): boolean {
  const path = new URL(url).pathname.toLowerCase()
  if (path.endsWith(".md") || path.endsWith(".markdown")) return true
  const sample = value.trimStart().slice(0, 200)
  return sample.startsWith("#") || sample.startsWith("---")
}

export function isHtml(value: string): boolean {
  return /^\s*<!doctype html|^\s*<html[\s>]/i.test(value.slice(0, 500))
}

export async function downloadDirectSkill(
  ctx: SourceContext,
  url: string,
  requestedName?: string,
): Promise<SkillBundle> {
  const candidates = url.endsWith("/") ? [`${url}SKILL.md`, url] : [url]
  let text: string | undefined
  let finalUrl = url
  let lastError: unknown
  for (const candidate of candidates) {
    try {
      const result = await downloadText(candidate, {
        ...ctx.download,
        headers: { accept: "text/markdown, text/plain, */*", ...ctx.download.headers },
      })
      text = result
      finalUrl = candidate
      break
    } catch (error) {
      lastError = error
      if (candidates.length === 1) throw error
    }
  }
  if (text === undefined) {
    throw lastError instanceof Error
      ? lastError
      : new SkillManagerError("NETWORK_ERROR", `Could not download ${url}`)
  }
  if (isHtml(text)) {
    throw new SkillManagerError("UNSUPPORTED_SOURCE", "The URL returned an HTML page, not a SKILL.md file.", {
      hint: "Use a direct raw SKILL.md URL or a GitHub/skills.sh link.",
    })
  }
  if (!looksLikeMarkdown(text, finalUrl)) {
    throw new SkillManagerError("INVALID_SKILL", "Downloaded content does not look like a Markdown skill file.", {
      details: { url: finalUrl, preview: text.slice(0, 200) },
    })
  }
  const normalized = normalizeText(text)
  const parsed = parseSkillDocument("SKILL.md", normalized).parsed
  const urlPath = new URL(finalUrl).pathname
  const parent = urlPath.split("/").filter(Boolean).at(-2)
  const suggestedId = sanitizeSkillId(
    requestedName || parsed.name || parent || new URL(finalUrl).hostname.split(".")[0] || "skill",
  )
  const source: SourceRef = { type: "url", url: finalUrl }
  const notes = [
    "This source exposes only a single Markdown file; supporting files cannot be discovered automatically.",
  ]
  if (assessCompatibility(parsed).status === "partial") {
    notes.push(...assessCompatibility(parsed).notes)
  }
  return {
    source,
    files: [makeFile("SKILL.md", normalized)],
    parsed,
    suggestedId,
    notes,
  }
}

export function isDirectSkillUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (!/^https?:$/.test(url.protocol)) return false
    if (url.pathname.toLowerCase().endsWith(".md")) return true
    return url.pathname.endsWith("/")
  } catch {
    return false
  }
}
