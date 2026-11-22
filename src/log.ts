import { appendFile, mkdir, rename, stat } from "node:fs/promises"
import path from "node:path"

export type LogLevel = "debug" | "info" | "warn" | "error"

export interface LogRecord {
  readonly ts: string
  readonly level: LogLevel
  readonly event: string
  readonly data?: Record<string, unknown>
}

const MAX_LOG_BYTES = 1_048_576
const SECRET_KEYS = /token|secret|password|authorization|api[-_]?key/i

function redact(value: unknown, key?: string): unknown {
  if (key && SECRET_KEYS.test(key)) return "[redacted]"
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item))
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {}
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      result[childKey] = redact(childValue, childKey)
    }
    return result
  }
  if (typeof value === "string" && value.length > 2_000) return `${value.slice(0, 2_000)}…`
  return value
}

export class Logger {
  readonly file: string
  private queue: Promise<void> = Promise.resolve()
  private failed = false

  constructor(stateDir: string) {
    this.file = path.join(stateDir, "activity.log")
  }

  event(level: LogLevel, event: string, data?: Record<string, unknown>) {
    const record: LogRecord = {
      ts: new Date().toISOString(),
      level,
      event,
      ...(data ? { data: redact(data) as Record<string, unknown> } : {}),
    }
    const line = JSON.stringify(record)
    if (level === "error") console.error(`[skill-manager] ${event}`, record.data ?? "")
    else if (level === "warn") console.warn(`[skill-manager] ${event}`, record.data ?? "")
    else console.log(`[skill-manager] ${event}`, record.data ?? "")
    this.queue = this.queue
      .then(() => this.write(line))
      .catch(() => {
        // Logging must never break an install. The console fallback above still ran.
      })
  }

  debug(event: string, data?: Record<string, unknown>) {
    this.event("debug", event, data)
  }
  info(event: string, data?: Record<string, unknown>) {
    this.event("info", event, data)
  }
  warn(event: string, data?: Record<string, unknown>) {
    this.event("warn", event, data)
  }
  error(event: string, data?: Record<string, unknown>) {
    this.event("error", event, data)
  }

  async flush() {
    await this.queue
  }

  private async write(line: string) {
    if (this.failed) return
    try {
      await mkdir(path.dirname(this.file), { recursive: true })
      try {
        const info = await stat(this.file)
        if (info.size > MAX_LOG_BYTES) {
          await rename(this.file, `${this.file}.1`).catch(() => undefined)
        }
      } catch {
        // File does not exist yet.
      }
      await appendFile(this.file, `${line}\n`, "utf8")
    } catch {
      this.failed = true
    }
  }
}
