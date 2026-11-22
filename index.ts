import { readFile } from "node:fs/promises"
import path from "node:path"
import { Plugin, Skill } from "@opencode/plugin"
import { loadConfig, type SkillManagerConfig } from "./src/config.ts"
import { SkillManagerError, toSkillManagerError } from "./src/errors.ts"
import { parseSkillDocument } from "./src/frontmatter.ts"
import { hashFiles } from "./src/hash.ts"
import { PreviewStore } from "./src/inspect.ts"
import { InstallerDeps } from "./src/install.ts"
import { Logger } from "./src/log.ts"
import { MANAGEMENT_SKILL_ID, readManagementSkill } from "./src/management-skill.ts"
import { safeSkillDirectory } from "./src/paths.ts"
import { RegistryStore } from "./src/registry.ts"
import { SourceContext, Cache } from "./src/sources/context.ts"
import { createToolHandlers, type ToolInvocation, type ToolOutput } from "./src/tools.ts"
import type { SourceKind } from "./src/sources/index.ts"
import type { LocalSkill, Registrar, RegisteredSkill } from "./src/types.ts"
import { SKILL_MANAGER_GUIDANCE } from "./src/guidance.ts"
import { AsyncLock } from "./src/sync.ts"

const VERSION = "1.0.0"

function toInfo(skill: LocalSkill): Skill.Info {
  return Skill.Info.make({
    id: Skill.ID.make(skill.id),
    name: Skill.Name.make(skill.name),
    ...(skill.description ? { description: skill.description } : {}),
    ...(skill.autoinvoke === undefined ? {} : { autoinvoke: skill.autoinvoke }),
    path: Skill.Info.fields.path.make(skill.path),
    content: skill.content,
  })
}

function looksLikeSkillRequest(text: string): boolean {
  const value = text.toLowerCase()
  if (/(^|\s)(skill\.md|\/skills\/)(\s|$|\/)/i.test(value)) return true
  if (/https?:\/\/(?:www\.)?(?:github\.com|raw\.githubusercontent\.com|skills\.sh)\//i.test(text)) return true
  if (
    /(?:^|[\s.,!?])(find|search|discover|install|add|get|need|looking for|is there|are there)(?:\s+\w+){0,4}\s+(?:a\s+)?(?:skill|skills|agent skill|capability)\b/i.test(
      value,
    )
  ) {
    return true
  }
  if (/(?:^|\s)(РЅР°Р№РґРё|РїРѕРёС‰Рё|СѓСЃС‚Р°РЅРѕРІРё|РїРѕРґРєР»СЋС‡Рё|РЅСѓР¶РµРЅ|РЅСѓР¶РЅР°|РЅСѓР¶РЅРѕ|РЅРµ С…РІР°С‚Р°РµС‚)(?:\s+\w+){0,5}\s+(?:СЃРєРёР»Р»|РЅР°РІС‹Рє|skill)/i.test(value)) {
    return true
  }
  return false
}

function parseFlags(args: readonly string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = []
  const flags: Record<string, string | true> = {}
  for (let index = 0; index < args.length; index++) {
    const value = args[index] ?? ""
    if (!value.startsWith("--")) {
      positional.push(value)
      continue
    }
    const [rawKey, ...rest] = value.slice(2).split("=")
    const key = rawKey ?? ""
    if (!key) continue
    if (rest.length > 0) {
      flags[key] = rest.join("=")
    } else if (args[index + 1] && !args[index + 1]!.startsWith("--")) {
      flags[key] = args[++index]!
    } else {
      flags[key] = true
    }
  }
  return { positional, flags }
}

function outputText(output: ToolOutput): string {
  return output.content.length > 12_000 ? `${output.content.slice(0, 12_000)}\nвЂ¦truncated` : output.content
}

export default Plugin.define({
  id: "skill-manager",
  async setup(ctx) {
    const projectDir = String(ctx.location.project?.canonical || ctx.location.directory)
    const skillsRoot = path.join(projectDir, ".opencode", "skills")
    const stateDir = path.join(projectDir, ".opencode", "skill-manager")
    const config: SkillManagerConfig = await loadConfig(projectDir, (ctx.options ?? {}) as Record<string, unknown>)
    const log = new Logger(stateDir)
    const registry = new RegistryStore(stateDir)
    const lock = new AsyncLock()
    const previews = new PreviewStore(config.maxPreviews, config.previewTtlMs)
    const registered = new Map<string, LocalSkill>()
    const builtin = new Map<string, LocalSkill>()

    await registry.load()
    const corrupt = registry.corruptPath()
    if (corrupt) log.warn("registry-quarantined", { file: corrupt })
    log.info("setup", {
      version: VERSION,
      opencode: ctx.app.version,
      projectDir,
      managed: registry.entries().length,
    })

    for (const entry of registry.entries()) {
      const file = path.join(skillsRoot, entry.id, "SKILL.md")
      try {
        const text = await readFile(file, "utf8")
        const { parsed, error } = parseSkillDocument(file, text)
        if (error) {
          log.warn("managed-skill-parse-warning", { id: entry.id, error })
        }
        registered.set(entry.id, {
          id: entry.id,
          name: parsed.name,
          ...(parsed.description ? { description: parsed.description } : {}),
          ...(parsed.autoinvoke === undefined ? {} : { autoinvoke: parsed.autoinvoke }),
          path: file,
          content: parsed.body,
        })
      } catch {
        log.warn("managed-skill-missing", { id: entry.id, path: file })
      }
    }

    const management = await readManagementSkill(projectDir)
    if (management.path.startsWith("skill://")) {
      builtin.set(MANAGEMENT_SKILL_ID, management)
      log.warn("management-skill-fallback", { path: management.path })
    }

    const registrar: Registrar = {
      add(skill) {
        registered.set(skill.id, skill)
      },
      remove(id) {
        if (builtin.has(id)) {
          throw new SkillManagerError("INVALID_INPUT", "The built-in Skill Discovery skill cannot be removed.")
        }
        registered.delete(id)
      },
      async reload() {
        await ctx.skill.reload()
      },
      async list(): Promise<readonly RegisteredSkill[]> {
        const listed = (await ctx.skill.list()).data
        return listed.map((skill) => ({
          id: String(skill.id),
          name: String(skill.name),
          ...(skill.description ? { description: String(skill.description) } : {}),
          ...(skill.autoinvoke === undefined ? {} : { autoinvoke: skill.autoinvoke }),
          content: skill.content,
          path: String(skill.path),
        }))
      },
    }

    await ctx.skill.transform((editor) => {
      for (const skill of [...builtin.values(), ...registered.values()]) {
        editor.add(toInfo(skill))
      }
    })

    const githubToken = process.env[config.githubTokenEnv]
    const sourceContext: SourceContext = {
      download: {
        timeoutMs: config.requestTimeoutMs,
        maxBytes: config.maxTotalBytes,
        allowPrivateHosts: config.allowPrivateHosts,
      },
      limits: {
        maxFiles: config.maxFiles,
        maxFileBytes: config.maxFileBytes,
        maxTotalBytes: config.maxTotalBytes,
        maxDepth: 12,
      },
      log,
      cache: new Cache(),
      ...(githubToken ? { githubToken } : {}),
      allowPrivateHosts: config.allowPrivateHosts,
    }

    const confirm = async (
      action: "skill_install" | "skill_uninstall",
      details: Record<string, unknown>,
      invocation?: ToolInvocation,
      save?: string[],
    ) => {
      if (!config.requireConfirmation) return
      const sessionID = invocation?.sessionID
      if (!sessionID) {
        log.warn("permission-skipped", { action, reason: "no session id" })
        return
      }
      try {
        await ctx.permission.assert({
          sessionID: sessionID as never,
          ...(invocation?.agent ? { agent: invocation.agent as never } : {}),
          ...(invocation?.messageID && invocation?.id
            ? {
                source: {
                  type: "tool" as const,
                  messageID: invocation.messageID as never,
                  id: invocation.id as never,
                },
              }
            : {}),
          action,
          resources: [String(details.id ?? "")],
          ...(save ? { save } : {}),
          metadata: details,
        })
      } catch (error) {
        if (error instanceof SkillManagerError) throw error
        const message = error instanceof Error && error.message ? error.message : "The user did not approve this skill operation."
        throw new SkillManagerError("PERMISSION_DENIED", message, {
          hint: "The operation was not performed. Ask the user before retrying.",
          cause: error,
        })
      }
    }

    const installerDeps: InstallerDeps = {
      projectDir,
      skillsRoot,
      stateDir,
      registry,
      registrar,
      log,
      config,
      lock,
    }

    const handlers = createToolHandlers({
      projectDir,
      skillsRoot,
      stateDir,
      config,
      registry,
      registrar,
      previews,
      log,
      context: sourceContext,
      installer: installerDeps,
      confirmInstall: (details, invocation) =>
        confirm("skill_install", { ...details, action: "install" }, invocation, [`skill:${details.id}`, `source:${details.source}`]),
      confirmUninstall: (details, invocation) =>
        confirm("skill_uninstall", { ...details, action: "uninstall" }, invocation, [`skill:${details.id}`]),
      version: VERSION,
    })

    const exec = async (
      tool: (input: any, invocation?: ToolInvocation) => Promise<ToolOutput>,
      input: unknown,
      context: { sessionID: string; agent: string; messageID: string; id: string },
    ) => {
      const output = await tool(input, context)
      return { content: output.content, metadata: output.metadata }
    }

    const tools = [
      {
        name: "search",
        description:
          "Search skills.sh and GitHub for Agent Skills (SKILL.md packages). Use when a task needs specialized domain knowledge, when the user asks for a skill, or when they provide a skill link. Returns candidates with source, description, available metrics, OpenCode compatibility, a heuristic quality score, and an inspectToken for the top candidates.",
        input: {
          type: "object",
          properties: {
            query: { type: "string", description: "Skill name, domain, task description, or a source URL." },
            source: {
              type: "string",
              enum: ["auto", "all", "skills.sh", "github"],
              description: "Where to search. auto uses both skills.sh and GitHub.",
            },
            limit: { type: "integer", minimum: 1, maximum: 20, description: "Maximum candidates (default 8)." },
          },
          required: ["query"],
          additionalProperties: false,
        } as const,
        run: (input: any) => handlers.search(input),
      },
      {
        name: "inspect",
        description:
          "Download and inspect a skill candidate without installing it. Shows frontmatter, file tree, SKILL.md preview, OpenCode compatibility, quality signals, security findings and install conflicts. Pass the returned inspectToken to skill_install.",
        input: {
          type: "object",
          properties: {
            token: { type: "string", description: "inspectToken returned by skill_search or a previous skill_inspect." },
            source: {
              type: "string",
              description: "GitHub repo/tree/blob URL, skills.sh URL, SKILL.md URL, owner/repo, or catalog index.json URL.",
            },
            path: { type: "string", description: "Skill directory inside a GitHub monorepo." },
            ref: { type: "string", description: "Git branch, tag or commit." },
            name: { type: "string", description: "Override the installed skill id." },
          },
          additionalProperties: false,
        } as const,
        run: (input: any) => handlers.inspect(input),
      },
      {
        name: "install",
        description:
          "Install an inspected skill into .opencode/skills/<id>/ and register it live through ctx.skill.transform + ctx.skill.reload. Requires user confirmation. Never executes downloaded scripts. Returns registered/verified state and says the skill is available to the next model step.",
        input: {
          type: "object",
          properties: {
            token: { type: "string", description: "inspectToken from skill_inspect (recommended)." },
            source: { type: "string", description: "Source URL or owner/repo if you did not inspect first." },
            path: { type: "string", description: "Skill directory inside a GitHub monorepo." },
            ref: { type: "string", description: "Git branch, tag or commit." },
            name: { type: "string", description: "Override the installed skill id." },
            overwrite: {
              type: "string",
              enum: ["error", "replace", "replace-unmanaged"],
              description: "Conflict policy. replace backs up the current managed skill; replace-unmanaged also replaces a directory not tracked by this manager.",
            },
            allowWarnings: { type: "boolean", description: "Allow installing a skill with security warnings after reviewing them." },
          },
          additionalProperties: false,
        } as const,
        run: (input: any, invocation?: ToolInvocation) => handlers.install(input, invocation),
      },
      {
        name: "list",
        description:
          "List project, global and built-in skills with their scope, path, managed/registered/advertised state, source and last install time. Use before searching to avoid redundant installs.",
        input: { type: "object", properties: {}, additionalProperties: false } as const,
        run: () => handlers.list(),
      },
      {
        name: "uninstall",
        description:
          "Remove a managed project skill from .opencode/skills, unregister it, and back it up by default. Requires user confirmation. Global and built-in skills are never modified.",
        input: {
          type: "object",
          properties: {
            id: { type: "string", description: "Exact project skill id." },
            force: { type: "string", enum: ["unmanaged"], description: "Allow removing a project directory not tracked by the manager." },
            purge: { type: "boolean", description: "Delete the backup instead of keeping it." },
          },
          required: ["id"],
          additionalProperties: false,
        } as const,
        run: (input: any, invocation?: ToolInvocation) => handlers.uninstall(input, invocation),
      },
      {
        name: "status",
        description: "Show the skill manager version, paths, counts and effective configuration.",
        input: { type: "object", properties: {}, additionalProperties: false } as const,
        run: () => handlers.status(),
      },
    ]

    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "skill", description: "Runtime Agent Skill discovery, inspection and installation" })
      for (const tool of tools) {
        editor.add({
          name: tool.name,
          description: tool.description,
          input: tool.input as never,
          options: { namespace: "skill", codemode: true },
          execute: async (input, context) =>
            exec(tool.run, input, {
              sessionID: String(context.sessionID),
              agent: String(context.agent),
              messageID: String(context.messageID),
              id: String(context.id),
            }),
        })
      }
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: "skill-manager",
        description: "Search, inspect, install, list and uninstall project Agent Skills without restarting OpenCode.",
        execute: async ({ sessionID, prompt }) => {
          const text = prompt.text.trim()
          const parts = text.split(/\s+/).filter(Boolean)
          if (parts[0] === "skill-manager" || parts[0] === "/skill-manager") parts.shift()
          const sub = parts.shift()?.toLowerCase() ?? "help"
          const { positional, flags } = parseFlags(parts)
          const invocation: ToolInvocation = { sessionID: String(sessionID) }
          let output: ToolOutput
          try {
            if (sub === "search") {
              output = await handlers.search({
                query: positional.join(" "),
                source: (typeof flags.source === "string" ? flags.source : "auto") as SourceKind,
                limit: typeof flags.limit === "string" ? Number(flags.limit) : 8,
              })
            } else if (sub === "inspect") {
              output = await handlers.inspect({
                ...(typeof flags.token === "string" ? { token: flags.token } : {}),
                source: positional.join(" "),
                ...(typeof flags.path === "string" ? { path: flags.path } : {}),
                ...(typeof flags.ref === "string" ? { ref: flags.ref } : {}),
              })
            } else if (sub === "install") {
              output = await handlers.install(
                {
                  ...(typeof flags.token === "string" ? { token: flags.token } : {}),
                  source: positional.join(" "),
                  ...(typeof flags.path === "string" ? { path: flags.path } : {}),
                  ...(typeof flags.ref === "string" ? { ref: flags.ref } : {}),
                  ...(typeof flags.name === "string" ? { name: flags.name } : {}),
                  ...(typeof flags.overwrite === "string"
                    ? { overwrite: flags.overwrite as "error" | "replace" | "replace-unmanaged" }
                    : {}),
                  ...(flags["allow-warnings"] ? { allowWarnings: true } : {}),
                },
                invocation,
              )
            } else if (sub === "list") {
              output = await handlers.list()
            } else if (sub === "uninstall") {
              output = await handlers.uninstall(
                {
                  id: positional[0],
                  ...(flags["force-unmanaged"] ? { force: "unmanaged" as const } : {}),
                  ...(flags.purge ? { purge: true } : {}),
                },
                invocation,
              )
            } else if (sub === "status") {
              output = await handlers.status()
            } else {
              output = {
                content: [
                  "Usage: skill-manager <command>",
                  "",
                  "  search <query> [--source=auto|all|skills.sh|github] [--limit=8]",
                  "  inspect <source> | --token=<inspectToken>",
                  "  install <source> | --token=<inspectToken> [--name=id] [--overwrite=replace] [--allow-warnings]",
                  "  list",
                  "  uninstall <id> [--force-unmanaged] [--purge]",
                  "  status",
                ].join("\n"),
              }
            }
          } catch (error) {
            output = {
              content: JSON.stringify(toSkillManagerError(error).toJSON(), null, 2),
            }
          }
          await ctx.session.synthetic({ sessionID, text: `skill-manager ${sub}\n\n${outputText(output)}` })
        },
      })
    })

    await ctx.session.hook("prompt", async (event) => {
      if (!config.autoAttachDiscoverySkill) return
      if (!looksLikeSkillRequest(event.prompt.text)) return
      try {
        const listed = (await ctx.skill.list()).data
        if (!listed.some((skill) => String(skill.id) === MANAGEMENT_SKILL_ID)) return
        event.prompt.skills ??= []
        if (!event.prompt.skills.some((skill) => String(skill.id) === MANAGEMENT_SKILL_ID)) {
          event.prompt.skills.push({ id: Skill.ID.make(MANAGEMENT_SKILL_ID) })
          log.info("discovery-skill-attached", { textLength: event.prompt.text.length })
        }
      } catch (error) {
        log.warn("discovery-skill-attach-failed", { error: (error as Error).message })
      }
    })

    await ctx.session.hook("context", (event) => {
      if (!config.injectGuidance) return
      if (event.system.some((part) => part.type === "text" && part.text.includes("<skill_manager>"))) return
      event.system.push({ type: "text", text: SKILL_MANAGER_GUIDANCE })
    })

    log.info("ready", {
      projectDir,
      registered: registered.size,
      builtin: builtin.size,
      tools: tools.map((tool) => `skill_${tool.name}`),
    })

    return async () => {
      await log.flush()
    }
  },
})

