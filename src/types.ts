export type SourceType = "skills.sh" | "github" | "url" | "catalog"

export interface SourceRef {
  readonly type: SourceType
  readonly url: string
  readonly repo?: string
  readonly ref?: string
  readonly path?: string
  readonly owner?: string
  readonly slug?: string
}

export interface SkillFile {
  readonly path: string
  readonly content: string
  readonly bytes: number
  readonly sha256: string
}

export interface ParsedSkill {
  readonly name: string
  readonly description?: string
  readonly autoinvoke?: boolean
  readonly body: string
  readonly frontmatter: Record<string, unknown>
}

export interface SecurityFinding {
  readonly severity: "info" | "warn" | "block"
  readonly rule: string
  readonly file: string
  readonly line?: number
  readonly message: string
  readonly excerpt?: string
}

export interface SecurityReport {
  readonly status: "clean" | "warnings" | "blocked"
  readonly findings: readonly SecurityFinding[]
  readonly counts: { readonly block: number; readonly warn: number; readonly info: number }
}

export interface SkillMetrics {
  readonly installs?: { readonly value: number; readonly source: "skills.sh" }
  readonly stars?: { readonly value: number; readonly source: "github" }
  readonly repoLastPush?: { readonly value: string; readonly source: "github pushed_at" }
  readonly license?: { readonly value: string; readonly source: "github" }
  readonly archived?: boolean
  readonly fork?: boolean
}

export interface Compatibility {
  readonly status: "opencode" | "partial" | "unknown" | "incompatible"
  readonly notes: readonly string[]
}

export interface QualityAssessment {
  readonly score: number
  readonly signals: readonly string[]
  readonly warnings: readonly string[]
}

export interface Candidate {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly source: SourceRef
  readonly files?: readonly SkillFile[]
  readonly metrics?: SkillMetrics
  readonly compatibility: Compatibility
  readonly quality: QualityAssessment
  readonly installs?: number
  readonly security?: SecurityReport
  readonly inspectToken?: string
}

export interface SkillBundle {
  readonly source: SourceRef
  readonly files: readonly SkillFile[]
  readonly parsed: ParsedSkill
  readonly suggestedId: string
  readonly metrics?: SkillMetrics
  readonly notes: readonly string[]
}

export interface Preview {
  readonly token: string
  readonly projectDir: string
  readonly source: SourceRef
  readonly files: readonly SkillFile[]
  readonly parsed: ParsedSkill
  readonly suggestedId: string
  readonly metrics?: SkillMetrics
  readonly security: SecurityReport
  readonly compatibility: Compatibility
  readonly quality: QualityAssessment
  readonly createdAt: number
  readonly notes: readonly string[]
}

export interface RegistryEntry {
  readonly id: string
  readonly source: SourceRef
  readonly hash: string
  readonly installedAt: string
  readonly updatedAt: string
  readonly files: readonly { readonly path: string; readonly bytes: number; readonly sha256: string }[]
  readonly security: { readonly status: SecurityStatus; readonly warnings: number }
  readonly installedBy: string
}

export type SecurityStatus = SecurityReport["status"]

export interface RegistryData {
  readonly version: 1
  readonly skills: Record<string, RegistryEntry>
}

export interface LocalSkill {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly autoinvoke?: boolean
  readonly path: string
  readonly content: string
}

export interface RegisteredSkill {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly autoinvoke?: boolean
  readonly content: string
  readonly path: string
}

export interface Registrar {
  add(skill: LocalSkill): void
  remove(id: string): void
  reload(): Promise<void>
  list(): Promise<readonly RegisteredSkill[]>
}

export interface InstallResult {
  readonly ok: true
  readonly status: "installed" | "updated" | "already-installed"
  readonly id: string
  readonly path: string
  readonly files: readonly string[]
  readonly registered: boolean
  readonly verified: boolean
  readonly advertised: boolean
  readonly availableIn: "next model step"
  readonly security: SecurityReport
  readonly messages: readonly string[]
  readonly backup?: string
}

export interface UninstallResult {
  readonly ok: true
  readonly id: string
  readonly removed: boolean
  readonly backup?: string
  readonly stillAvailableFrom?: readonly string[]
  readonly messages: readonly string[]
}

export interface ToolError {
  readonly ok: false
  readonly error: {
    readonly code: string
    readonly message: string
    readonly hint?: string
    readonly details?: unknown
  }
}

export type ToolResult<T> = ({ readonly ok: true } & T) | ToolError

export interface Limits {
  readonly maxFiles: number
  readonly maxFileBytes: number
  readonly maxTotalBytes: number
  readonly maxDepth: number
}
