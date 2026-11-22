import type { Compatibility, ParsedSkill, QualityAssessment, SecurityReport, SkillFile, SkillMetrics } from "./types.ts"

export function assessCompatibility(parsed: ParsedSkill, error?: string): Compatibility {
  if (error) {
    return { status: "incompatible", notes: [error] }
  }
  const notes: string[] = []
  if (!parsed.description?.trim()) notes.push("No description; OpenCode will not advertise this skill to the model.")
  if (parsed.autoinvoke === false) notes.push("Frontmatter hides this skill from the model's available list.")
  if (!parsed.body.trim()) notes.push("SKILL.md has no body.")
  return { status: notes.length === 0 ? "opencode" : "partial", notes }
}

export function assessQuality(input: {
  parsed: ParsedSkill
  parsedError?: string
  files?: readonly SkillFile[]
  metrics?: SkillMetrics
  security?: SecurityReport
  compatibility: Compatibility
}): QualityAssessment {
  let score = 30
  const signals: string[] = []
  const warnings: string[] = []

  if (input.compatibility.status === "opencode") {
    score += 20
    signals.push("valid directory-style SKILL.md with a description")
  } else if (input.compatibility.status === "partial") {
    score += 8
    warnings.push(...input.compatibility.notes)
  } else {
    warnings.push("not a valid OpenCode skill package")
  }

  if (input.parsedError) {
    score -= 20
    warnings.push(input.parsedError)
  }

  const fileCount = input.files?.length ?? 0
  if (fileCount > 1) {
    score += 8
    signals.push(`${fileCount - 1} supporting file(s) preserved`)
  }

  const bodyLength = input.parsed.body.trim().length
  if (bodyLength >= 500) {
    score += 8
    signals.push("substantive instructions (>= 500 characters)")
  } else if (bodyLength > 0 && bodyLength < 120) {
    score -= 5
    warnings.push("very short instruction body")
  }

  const installs = input.metrics?.installs?.value
  if (installs !== undefined) {
    if (installs >= 10_000) {
      score += 10
      signals.push(`${installs} installs on skills.sh`)
    } else if (installs >= 1_000) {
      score += 6
      signals.push(`${installs} installs on skills.sh`)
    } else if (installs > 0) {
      score += 2
      signals.push(`${installs} installs on skills.sh`)
    }
  }

  const stars = input.metrics?.stars?.value
  if (stars !== undefined) {
    if (stars >= 1_000) {
      score += 8
      signals.push(`${stars} GitHub stars`)
    } else if (stars >= 100) {
      score += 5
      signals.push(`${stars} GitHub stars`)
    } else if (stars > 0) {
      score += 2
      signals.push(`${stars} GitHub stars`)
    }
  }

  if (input.metrics?.archived) {
    score -= 15
    warnings.push("repository is archived")
  }
  if (input.metrics?.fork) {
    score -= 3
    warnings.push("repository is a fork")
  }

  if (input.security) {
    if (input.security.status === "clean") {
      score += 10
      signals.push("security scan found no warnings")
    } else if (input.security.status === "warnings") {
      score -= Math.min(15, input.security.counts.warn * 3)
      warnings.push(`${input.security.counts.warn} security warning(s)`)
    } else {
      score -= 40
      warnings.push(`${input.security.counts.block} blocking security finding(s)`)
    }
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    signals,
    warnings,
  }
}
