import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { RegistryStore } from "../src/registry.ts"

describe("registry", () => {
  let root: string | undefined
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  it("round-trips entries atomically", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "skill-registry-"))
    const store = new RegistryStore(root)
    await store.load()
    await store.set({
      id: "demo",
      source: { type: "url", url: "https://example.com/SKILL.md" },
      hash: "abc",
      installedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      files: [{ path: "SKILL.md", bytes: 10, sha256: "def" }],
      security: { status: "clean", warnings: 0 },
      installedBy: "test",
    })
    const reloaded = new RegistryStore(root)
    await reloaded.load()
    expect(reloaded.get("demo")?.hash).toBe("abc")
    expect(await readFile(path.join(root, "registry.json"), "utf8")).toContain('"demo"')
  })

  it("quarantines corrupt JSON instead of failing", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "skill-registry-"))
    await writeFile(path.join(root, "registry.json"), "{not json", "utf8")
    const store = new RegistryStore(root)
    await store.load()
    expect(store.entries()).toEqual([])
    expect(store.corruptPath()).toBeTruthy()
  })

  it("removes entries", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "skill-registry-"))
    const store = new RegistryStore(root)
    await store.load()
    await store.set({
      id: "demo",
      source: { type: "url", url: "https://example.com" },
      hash: "abc",
      installedAt: "x",
      updatedAt: "x",
      files: [],
      security: { status: "clean", warnings: 0 },
      installedBy: "test",
    })
    await store.remove("demo")
    expect(store.get("demo")).toBeUndefined()
  })
})
