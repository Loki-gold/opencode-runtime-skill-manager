import { SkillManagerError } from "./errors.ts"

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface DownloadOptions {
  readonly timeoutMs: number
  readonly maxBytes: number
  readonly allowPrivateHosts: boolean
  readonly signal?: AbortSignal
  readonly headers?: Record<string, string>
  readonly fetchImpl?: FetchLike
  readonly retries?: number
  readonly userAgent?: string
  readonly sleep?: (ms: number) => Promise<void>
}

export interface DownloadResult {
  readonly url: string
  readonly bytes: Uint8Array
  readonly text: string
  readonly contentType: string
  readonly status: number
  readonly headers: Headers
}

const DEFAULT_USER_AGENT = "opencode-runtime-skill-manager/0.1 (+https://opencode.ai)"
const REDIRECTS = new Set([301, 302, 303, 307, 308])

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function privateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true
  }
  if (host === "::1" || host === "::" || (host.includes(":") && (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")))) {
    return true
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!ipv4) return false
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])]
  if (![a, b, Number(ipv4[3]), Number(ipv4[4])].every((part) => part >= 0 && part <= 255)) return false
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  )
}

export function assertSafeUrl(input: string | URL, allowPrivateHosts: boolean): URL {
  let url: URL
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(input)
  } catch {
    throw new SkillManagerError("INVALID_SOURCE", `Invalid URL: ${String(input)}`)
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new SkillManagerError("UNSUPPORTED_SOURCE", `Unsupported URL protocol: ${url.protocol}`, {
      hint: "Only http(s) URLs are supported.",
    })
  }
  if (url.username || url.password) {
    throw new SkillManagerError("INVALID_SOURCE", "URLs with embedded credentials are not allowed.")
  }
  if (url.protocol === "http:" && !allowPrivateHosts) {
    throw new SkillManagerError("UNSUPPORTED_SOURCE", "Plain HTTP is disabled.", {
      hint: "Use HTTPS, or enable allowPrivateHosts for a local test catalog.",
    })
  }
  if (privateHost(url.hostname) && !allowPrivateHosts) {
    throw new SkillManagerError("UNSUPPORTED_SOURCE", `Private or local host is blocked: ${url.hostname}`, {
      hint: "Set allowPrivateHosts: true in .opencode/skill-manager/config.json only if you trust the source.",
    })
  }
  return url
}

function combineSignals(signals: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((item): item is AbortSignal => Boolean(item))
  if (present.length === 0) return undefined
  if (present.length === 1) return present[0]
  const any = (AbortSignal as unknown as { any?: (values: AbortSignal[]) => AbortSignal }).any
  if (any) return any(present)
  const controller = new AbortController()
  for (const signal of present) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after")
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000)
  const date = Date.parse(header)
  if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  return undefined
}

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const length = Number(response.headers.get("content-length"))
  if (Number.isFinite(length) && length > maxBytes) {
    throw new SkillManagerError("TOO_LARGE", `Response is ${length} bytes, limit is ${maxBytes}.`)
  }
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new SkillManagerError("TOO_LARGE", `Response exceeds the ${maxBytes} byte limit.`, {
        hint: "This source is too large to inspect safely.",
      })
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export async function download(input: string | URL, options: DownloadOptions): Promise<DownloadResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? defaultSleep
  const retries = options.retries ?? 2
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT
  let url = assertSafeUrl(input, options.allowPrivateHosts)
  let attempt = 0
  let redirects = 0

  while (true) {
    const timeout = AbortSignal.timeout(options.timeoutMs)
    const signal = combineSignals([options.signal, timeout])
    let response: Response
    try {
      response = await fetchImpl(url, {
        redirect: "manual",
        signal,
        headers: {
          "user-agent": userAgent,
          accept: "*/*",
          ...options.headers,
        },
      })
    } catch (error) {
      if (attempt < retries) {
        attempt++
        await sleep(400 * 2 ** (attempt - 1) + Math.floor(Math.random() * 200))
        continue
      }
      if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
        throw new SkillManagerError("TIMEOUT", `Request timed out after ${options.timeoutMs}ms: ${url.href}`, {
          cause: error,
        })
      }
      throw new SkillManagerError("NETWORK_ERROR", `Network error fetching ${url.href}: ${(error as Error).message}`, {
        cause: error,
      })
    }

    if (REDIRECTS.has(response.status)) {
      const location = response.headers.get("location")
      if (!location) {
        throw new SkillManagerError("NETWORK_ERROR", `Redirect without Location from ${url.href}`)
      }
      redirects++
      if (redirects > 4) {
        throw new SkillManagerError("NETWORK_ERROR", `Too many redirects starting at ${String(input)}`)
      }
      url = assertSafeUrl(new URL(location, url), options.allowPrivateHosts)
      continue
    }

    if (response.status === 429 || response.status >= 500) {
      if (attempt < retries) {
        attempt++
        const delay = retryAfterMs(response) ?? 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250)
        await sleep(Math.min(delay, 30_000))
        continue
      }
      const retry = retryAfterMs(response)
      throw new SkillManagerError("RATE_LIMITED", `Source returned HTTP ${response.status}: ${url.href}`, {
        hint: retry ? `Retry after ${Math.ceil(retry / 1_000)}s.` : "Try again later or use another source.",
        details: { status: response.status },
      })
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 500)
      throw new SkillManagerError("NETWORK_ERROR", `Source returned HTTP ${response.status}: ${url.href}`, {
        details: { status: response.status, body: detail },
      })
    }

    const bytes = await readLimited(response, options.maxBytes)
    return {
      url: url.href,
      bytes,
      text: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
      contentType: response.headers.get("content-type") ?? "",
      status: response.status,
      headers: response.headers,
    }
  }
}

export async function downloadText(input: string | URL, options: DownloadOptions): Promise<string> {
  return (await download(input, options)).text
}

export async function downloadJson<T = unknown>(input: string | URL, options: DownloadOptions): Promise<T> {
  const result = await download(input, {
    ...options,
    headers: { accept: "application/json", ...options.headers },
  })
  try {
    return JSON.parse(result.text.replace(/^\uFEFF/, "")) as T
  } catch (error) {
    throw new SkillManagerError("NETWORK_ERROR", `Source did not return valid JSON: ${result.url}`, {
      cause: error,
      details: { contentType: result.contentType, preview: result.text.slice(0, 300) },
    })
  }
}
