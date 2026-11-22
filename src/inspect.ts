import { randomBytes } from "node:crypto"
import { assessCompatibility, assessQuality } from "./assess.ts"
import { SkillManagerError } from "./errors.ts"
import { analyzeFiles } from "./security.ts"
import type { Preview, SkillBundle } from "./types.ts"

export class PreviewStore {
  private readonly values = new Map<string, Preview>()
  private readonly max: number
  private readonly ttlMs: number

  constructor(max: number, ttlMs: number) {
    this.max = max
    this.ttlMs = ttlMs
  }

  put(preview: Preview): Preview {
    this.prune()
    this.values.set(preview.token, preview)
    while (this.values.size > this.max) {
      const oldest = this.values.keys().next().value
      if (!oldest) break
      this.values.delete(oldest)
    }
    return preview
  }

  get(token: string, projectDir: string): Preview {
    const preview = this.values.get(token)
    if (!preview) {
      throw new SkillManagerError("NOT_FOUND", "Inspection token is unknown or expired.", {
        hint: "Run skill_inspect again to create a fresh token.",
      })
    }
    if (preview.createdAt + this.ttlMs < Date.now()) {
      this.values.delete(token)
      throw new SkillManagerError("NOT_FOUND", "Inspection token expired.", {
        hint: "Run skill_inspect again to create a fresh token.",
      })
    }
    if (preview.projectDir !== projectDir) {
      throw new SkillManagerError("INVALID_INPUT", "Inspection token belongs to a different project.")
    }
    return preview
  }

  prune() {
    const now = Date.now()
    for (const [token, preview] of this.values) {
      if (preview.createdAt + this.ttlMs < now) this.values.delete(token)
    }
  }
}

export function createPreview(
  projectDir: string,
  bundle: SkillBundle,
  options: { allowScripts: boolean; ttlMs: number },
): Preview {
  const security = analyzeFiles(bundle.files, { allowScripts: options.allowScripts })
  const compatibility = assessCompatibility(bundle.parsed)
  const quality = assessQuality({
    parsed: bundle.parsed,
    files: bundle.files,
    metrics: bundle.metrics,
    security,
    compatibility,
  })
  return {
    token: `sm_${randomBytes(24).toString("base64url")}`,
    projectDir,
    source: bundle.source,
    files: bundle.files,
    parsed: bundle.parsed,
    suggestedId: bundle.suggestedId,
    metrics: bundle.metrics,
    security,
    compatibility,
    quality,
    createdAt: Date.now(),
    notes: bundle.notes,
  }
}
