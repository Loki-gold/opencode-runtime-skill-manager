import type { ParsedSkill } from "./types.ts"

export interface FrontmatterResult {
  readonly data: Record<string, unknown>
  readonly body: string
  readonly error?: string
}

const normalize = (text: string) => text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n")

function stripComment(value: string): string {
  let single = false
  let double = false
  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    if (char === "'" && !double) single = !single
    else if (char === '"' && !single && value[index - 1] !== "\\") double = !double
    else if (char === "#" && !single && !double && (index === 0 || /\s/.test(value[index - 1] ?? ""))) {
      return value.slice(0, index).trimEnd()
    }
  }
  return value
}

function parseScalar(raw: string): unknown {
  const value = stripComment(raw).trim()
  if (value === "") return ""
  if (value === "~" || value.toLowerCase() === "null") return null
  if (/^(true|yes|on)$/i.test(value)) return true
  if (/^(false|no|off)$/i.test(value)) return false
  if (/^-?\d+$/.test(value)) return Number(value)
  if (/^-?\d+\.\d+$/.test(value)) return Number(value)
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replaceAll("''", "'")
  }
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    const inner = value.slice(1, -1)
    try {
      return JSON.parse(`"${inner}"`)
    } catch {
      return inner.replaceAll('\\"', '"').replaceAll("\\\\", "\\")
    }
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((item) => parseScalar(item))
      .filter((item) => item !== "")
  }
  return value
}

function blockScalar(
  lines: string[],
  start: number,
  parentIndent: number,
  style: "|" | ">",
  chomp: "" | "-" | "+",
): { value: string; next: number } {
  const collected: string[] = []
  let index = start
  let blockIndent: number | undefined
  while (index < lines.length) {
    const line = lines[index] ?? ""
    if (line.trim() === "") {
      collected.push("")
      index++
      continue
    }
    const indent = line.match(/^ */)?.[0].length ?? 0
    if (indent <= parentIndent) break
    if (blockIndent === undefined) blockIndent = indent
    collected.push(line.slice(Math.min(blockIndent, indent)))
    index++
  }
  while (collected.length > 0 && collected[collected.length - 1] === "") collected.pop()
  let value = style === "|" ? collected.join("\n") : collected.join(" ").replace(/\s+/g, " ").trim()
  if (chomp !== "-") value += "\n"
  return { value, next: index }
}

export function parseFrontmatter(text: string): FrontmatterResult {
  const source = normalize(text)
  const lines = source.split("\n")
  if ((lines[0] ?? "").trim() !== "---") {
    return { data: {}, body: source.trimEnd() }
  }
  let closing = -1
  for (let index = 1; index < lines.length; index++) {
    const line = (lines[index] ?? "").trim()
    if (line === "---" || line === "...") {
      closing = index
      break
    }
  }
  if (closing === -1) {
    return { data: {}, body: source.trimEnd(), error: "frontmatter is not closed with ---" }
  }
  const body = lines
    .slice(closing + 1)
    .join("\n")
    .replace(/^\n+/, "")
    .trimEnd()
  const yaml = lines.slice(1, closing)
  const data: Record<string, unknown> = {}
  const stack: { indent: number; container: Record<string, unknown> }[] = [{ indent: -1, container: data }]
  let error: string | undefined
  let parsedKeys = 0

  for (let index = 0; index < yaml.length; index++) {
    const raw = yaml[index] ?? ""
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const indent = raw.match(/^ */)?.[0].length ?? 0

    if (trimmed.startsWith("- ")) {
      const parent = stack[stack.length - 1]
      if (!parent) continue
      // Arrays are not needed by OpenCode metadata, but keep them so unknown
      // frontmatter does not make the whole file invalid.
      const lastKey = Object.keys(parent.container).at(-1)
      if (lastKey) {
        const current = parent.container[lastKey]
        if (Array.isArray(current)) current.push(parseScalar(trimmed.slice(2)))
        else parent.container[lastKey] = [parseScalar(trimmed.slice(2))]
      }
      continue
    }

    const match = raw.match(/^(\s*)([^:#][^:]*):(.*)$/)
    if (!match) {
      error ??= `unsupported frontmatter line ${index + 2}: ${trimmed.slice(0, 120)}`
      continue
    }
    parsedKeys++
    while (stack.length > 1 && indent <= (stack[stack.length - 1]?.indent ?? -1)) stack.pop()
    const container = stack[stack.length - 1]?.container ?? data
    const key = (match[2] ?? "").trim().replace(/^["']|["']$/g, "")
    const rest = (match[3] ?? "").trim()

    if (!rest) {
      const child: Record<string, unknown> = {}
      container[key] = child
      stack.push({ indent, container: child })
      continue
    }

    const scalarMatch = rest.match(/^([|>])([+-]?)$/)
    if (scalarMatch) {
      const block = blockScalar(yaml, index + 1, indent, scalarMatch[1] as "|" | ">", (scalarMatch[2] ?? "") as "" | "-" | "+")
      container[key] = block.value
      index = block.next - 1
      continue
    }

    container[key] = parseScalar(rest)
  }

  if (parsedKeys === 0 && yaml.some((line) => line.trim() && !line.trim().startsWith("#"))) {
    error ??= "frontmatter does not contain a mapping"
  }

  return { data, body, ...(error ? { error } : {}) }
}

export function parseSkillDocument(filepath: string, text: string): { parsed: ParsedSkill; error?: string } {
  const result = parseFrontmatter(text)
  const nameValue = result.data.name
  const descriptionValue = result.data.description
  const metadata = result.data.metadata
  const opencodeAutoinvoke =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)["opencode/autoinvoke"]
      : undefined
  const disable = result.data["disable-model-invocation"]
  const toBool = (value: unknown): boolean | undefined => {
    if (typeof value === "boolean") return value
    if (typeof value === "number") return value === 1 ? true : value === 0 ? false : undefined
    if (typeof value !== "string") return undefined
    const normalized = value.trim().toLowerCase()
    if (["true", "yes", "on", "1"].includes(normalized)) return true
    if (["false", "no", "off", "0"].includes(normalized)) return false
    return undefined
  }
  const autoinvoke = toBool(opencodeAutoinvoke) ?? (toBool(disable) ? false : undefined)
  const fallbackName = filepath.split(/[\\/]/).at(-2) ?? "skill"
  return {
    parsed: {
      name: typeof nameValue === "string" && nameValue.trim() ? nameValue : fallbackName,
      ...(typeof descriptionValue === "string" ? { description: descriptionValue } : {}),
      ...(autoinvoke === undefined ? {} : { autoinvoke }),
      body: result.body,
      frontmatter: result.data,
    },
    ...(result.error ? { error: result.error } : {}),
  }
}
