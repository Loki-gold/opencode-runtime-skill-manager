import { createServer } from "node:http"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { download } from "../src/download.ts"

let server: ReturnType<typeof createServer>
let base: string
let hits = 0

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    if (url.pathname === "/ok") {
      response.writeHead(200, { "content-type": "text/plain" })
      response.end("hello")
      return
    }
    if (url.pathname === "/large") {
      response.writeHead(200, { "content-type": "text/plain" })
      response.end("x".repeat(2_000))
      return
    }
    if (url.pathname === "/redirect") {
      response.writeHead(302, { location: "/ok" })
      response.end()
      return
    }
    if (url.pathname === "/loop") {
      response.writeHead(302, { location: "/loop" })
      response.end()
      return
    }
    if (url.pathname === "/retry") {
      hits++
      if (hits < 2) {
        response.writeHead(429, { "retry-after": "0" })
        response.end("wait")
        return
      }
      response.writeHead(200, { "content-type": "text/plain" })
      response.end("retried")
      return
    }
    if (url.pathname === "/hang") {
      return
    }
    response.writeHead(404)
    response.end("missing")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no port")
  base = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const options = {
  timeoutMs: 2_000,
  maxBytes: 1_000,
  allowPrivateHosts: true,
  retries: 0,
  sleep: async () => undefined,
}

describe("safe download", () => {
  it("downloads text and follows redirects", async () => {
    expect((await download(`${base}/ok`, options)).text).toBe("hello")
    expect((await download(`${base}/redirect`, options)).text).toBe("hello")
  })

  it("enforces the byte limit", async () => {
    await expect(download(`${base}/large`, options)).rejects.toMatchObject({ code: "TOO_LARGE" })
  })

  it("retries 429 responses", async () => {
    hits = 0
    expect((await download(`${base}/retry`, { ...options, retries: 1 })).text).toBe("retried")
    expect(hits).toBe(2)
  })

  it("stops redirect loops", async () => {
    await expect(download(`${base}/loop`, options)).rejects.toMatchObject({ code: "NETWORK_ERROR" })
  })

  it("reports HTTP errors", async () => {
    await expect(download(`${base}/missing`, options)).rejects.toMatchObject({ code: "NETWORK_ERROR" })
  })

  it("reports timeouts", async () => {
    await expect(download(`${base}/hang`, { ...options, timeoutMs: 80 })).rejects.toMatchObject({ code: "TIMEOUT" })
  })
})
