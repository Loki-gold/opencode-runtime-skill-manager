import { readFile } from "node:fs/promises"
import path from "node:path"

export interface SkillManagerConfig {
  readonly requireConfirmation: boolean
  readonly allowPrivateHosts: boolean
  readonly allowScripts: boolean
  readonly autoAttachDiscoverySkill: boolean
  readonly injectGuidance: boolean
  readonly githubTokenEnv: string
  readonly requestTimeoutMs: number
  readonly maxFiles: number
  readonly maxFileBytes: number
  readonly maxTotalBytes: number
  readonly maxPreviews: number
  readonly previewTtlMs: number
}

export const DEFAULT_CONFIG: SkillManagerConfig = {
  requireConfirmation: true,
  allowPrivateHosts: false,
  allowScripts: false,
  autoAttachDiscoverySkill: true,
  injectGuidance: true,
  githubTokenEnv: "GITHUB_TOKEN",
  requestTimeoutMs: 20_000,
  maxFiles: 200,
  maxFileBytes: 1_048_576,
  maxTotalBytes: 5_242_880,
  maxPreviews: 20,
  previewTtlMs: 15 * 60_000,
}

const boolean = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback)
const number = (value: unknown, fallback: number, min: number, max: number) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}
const string = (value: unknown, fallback: string) => (typeof value === "string" && value.trim() ? value : fallback)

function normalize(raw: Record<string, unknown>, base: SkillManagerConfig = DEFAULT_CONFIG): SkillManagerConfig {
  return {
    requireConfirmation: boolean(raw.requireConfirmation, base.requireConfirmation),
    allowPrivateHosts: boolean(raw.allowPrivateHosts, base.allowPrivateHosts),
    allowScripts: boolean(raw.allowScripts, base.allowScripts),
    autoAttachDiscoverySkill: boolean(raw.autoAttachDiscoverySkill, base.autoAttachDiscoverySkill),
    injectGuidance: boolean(raw.injectGuidance, base.injectGuidance),
    githubTokenEnv: string(raw.githubTokenEnv, base.githubTokenEnv),
    requestTimeoutMs: number(raw.requestTimeoutMs, base.requestTimeoutMs, 1_000, 120_000),
    maxFiles: number(raw.maxFiles, base.maxFiles, 1, 2_000),
    maxFileBytes: number(raw.maxFileBytes, base.maxFileBytes, 1_024, 20_000_000),
    maxTotalBytes: number(raw.maxTotalBytes, base.maxTotalBytes, 1_024, 50_000_000),
    maxPreviews: number(raw.maxPreviews, base.maxPreviews, 1, 200),
    previewTtlMs: number(raw.previewTtlMs, base.previewTtlMs, 10_000, 86_400_000),
  }
}

export async function loadConfig(
  projectDir: string,
  pluginOptions: Record<string, unknown> = {},
): Promise<SkillManagerConfig> {
  let fileConfig: Record<string, unknown> = {}
  const file = path.join(projectDir, ".opencode", "skill-manager", "config.json")
  try {
    const text = await readFile(file, "utf8")
    const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ""))
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      fileConfig = parsed as Record<string, unknown>
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      // A malformed config must not prevent the plugin from loading. Defaults are safe.
      console.error("[skill-manager] failed to read config.json:", (error as Error).message)
    }
  }
  return normalize({ ...fileConfig, ...pluginOptions })
}
