import { describe, expect, it } from "vitest"
import {
  inferSkillIdFromPath,
  isSafeRelativePath,
  isValidSkillId,
  sanitizeSkillId,
  safeResolve,
  uniqueSkillId,
} from "../src/paths.ts"
import { assertSafeUrl } from "../src/download.ts"

describe("skill paths", () => {
  it("accepts normal relative paths", () => {
    expect(isSafeRelativePath("SKILL.md")).toBe(true)
    expect(isSafeRelativePath("references/guide.md")).toBe(true)
    expect(isSafeRelativePath("scripts/run.py")).toBe(true)
  })

  it("rejects traversal, absolute paths, backslashes and reserved names", () => {
    for (const value of [
      "../evil.md",
      "/etc/passwd",
      "C:\\Windows\\system.ini",
      "C:/Windows/system.ini",
      "a\\b.md",
      "a//b.md",
      "CON",
      "nul.txt",
      "folder/COM1",
      "file.",
      "file ",
      "https://example.com/SKILL.md",
      "a/../../b",
    ]) {
      expect(isSafeRelativePath(value), value).toBe(false)
    }
  })

  it("resolves inside the root and refuses escapes", () => {
    const root = process.cwd()
    expect(safeResolve(root, "references/a.md")).toContain("references")
    expect(() => safeResolve(root, "../a.md")).toThrow()
  })

  it("sanitizes and validates ids", () => {
    expect(sanitizeSkillId("Blender Animation!")).toBe("blender-animation")
    expect(sanitizeSkillId("---")).toBe("skill")
    expect(isValidSkillId("blender-animation")).toBe(true)
    expect(isValidSkillId("Blender Animation")).toBe(false)
    expect(isValidSkillId("a".repeat(65))).toBe(false)
  })

  it("allocates unique ids", () => {
    expect(uniqueSkillId("demo", new Set())).toBe("demo")
    expect(uniqueSkillId("demo", new Set(["demo"]))).toBe("demo-2")
  })

  it("infers ids from file paths", () => {
    expect(inferSkillIdFromPath("skills/demo/SKILL.md")).toBe("demo")
    expect(inferSkillIdFromPath("skills/demo.md")).toBe("demo")
  })
})

describe("URL safety", () => {
  it("accepts public HTTPS", () => {
    expect(assertSafeUrl("https://example.com/SKILL.md", false).hostname).toBe("example.com")
  })

  it("rejects HTTP and private hosts by default", () => {
    expect(() => assertSafeUrl("http://example.com/x", false)).toThrow()
    expect(() => assertSafeUrl("http://127.0.0.1:8080/SKILL.md", false)).toThrow()
    expect(() => assertSafeUrl("http://localhost/SKILL.md", false)).toThrow()
    expect(() => assertSafeUrl("https://192.168.1.10/SKILL.md", false)).toThrow()
  })

  it("allows private hosts only when opted in", () => {
    expect(assertSafeUrl("http://127.0.0.1:8080/SKILL.md", true).port).toBe("8080")
  })

  it("rejects credentials and non-http protocols", () => {
    expect(() => assertSafeUrl("https://user:pass@example.com/x", true)).toThrow()
    expect(() => assertSafeUrl("file:///etc/passwd", true)).toThrow()
    expect(() => assertSafeUrl("javascript:alert(1)", true)).toThrow()
  })
})
