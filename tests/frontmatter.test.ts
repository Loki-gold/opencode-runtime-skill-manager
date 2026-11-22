import { describe, expect, it } from "vitest"
import { parseFrontmatter, parseSkillDocument } from "../src/frontmatter.ts"

describe("frontmatter", () => {
  it("parses a basic skill document and strips frontmatter", () => {
    const result = parseFrontmatter("---\nname: Demo\ndescription: A demo skill\n---\n# Body\n\nText\n")
    expect(result.data).toMatchObject({ name: "Demo", description: "A demo skill" })
    expect(result.body).toBe("# Body\n\nText")
    expect(result.error).toBeUndefined()
  })

  it("handles CRLF, quoted strings, comments and block scalars", () => {
    const text =
      "---\r\nname: 'Demo Skill'\r\ndescription: >\r\n  First line\r\n  second line\r\nmetadata:\r\n  opencode/autoinvoke: false\r\nlicense: MIT # comment\r\n---\r\nBody\r\n"
    const result = parseFrontmatter(text)
    expect(result.data.name).toBe("Demo Skill")
    expect(result.data.description).toBe("First line second line\n")
    expect((result.data.metadata as Record<string, unknown>)["opencode/autoinvoke"]).toBe(false)
    expect(result.data.license).toBe("MIT")
  })

  it("parses literal blocks", () => {
    const result = parseFrontmatter("---\ndescription: |\n  line one\n  line two\n---\nBody")
    expect(result.data.description).toBe("line one\nline two\n")
  })

  it("maps disable-model-invocation to autoinvoke false", () => {
    const parsed = parseSkillDocument("SKILL.md", "---\nname: X\ndescription: Y\ndisable-model-invocation: true\n---\n# X")
    expect(parsed.parsed.autoinvoke).toBe(false)
  })

  it("lets metadata.opencode/autoinvoke win", () => {
    const parsed = parseSkillDocument(
      "SKILL.md",
      "---\nname: X\ndescription: Y\ndisable-model-invocation: true\nmetadata:\n  opencode/autoinvoke: true\n---\nX",
    )
    expect(parsed.parsed.autoinvoke).toBe(true)
  })

  it("reports an unclosed frontmatter block", () => {
    const result = parseFrontmatter("---\nname: X\nBody")
    expect(result.error).toContain("not closed")
    expect(result.body).toContain("name: X")
  })

  it("accepts a document without frontmatter", () => {
    const parsed = parseSkillDocument("C:/skills/demo/SKILL.md", "# Demo\n\nBody")
    expect(parsed.parsed.name).toBe("demo")
    expect(parsed.parsed.body).toContain("# Demo")
  })
})
