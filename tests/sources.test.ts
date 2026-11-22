import { describe, expect, it } from "vitest"
import { parseGithubShorthand, parseGithubUrl } from "../src/sources/github.ts"
import { parseSkillsShUrl } from "../src/sources/skills-sh.ts"
import { parseCatalogUrl } from "../src/sources/catalog.ts"
import { parseInput } from "../src/sources/index.ts"

describe("source parsing", () => {
  it("parses GitHub repository, tree, blob and raw URLs", () => {
    expect(parseGithubUrl("https://github.com/owner/repo")).toMatchObject({ owner: "owner", repo: "repo", kind: "repo" })
    expect(parseGithubUrl("https://github.com/owner/repo/tree/main/skills/foo")).toMatchObject({
      owner: "owner",
      repo: "repo",
      ref: "main",
      path: "skills/foo",
      kind: "tree",
    })
    expect(parseGithubUrl("https://github.com/owner/repo/blob/main/skills/foo/SKILL.md")).toMatchObject({
      ref: "main",
      path: "skills/foo/SKILL.md",
      kind: "blob",
    })
    expect(parseGithubUrl("https://raw.githubusercontent.com/owner/repo/main/skills/foo/SKILL.md")).toMatchObject({
      owner: "owner",
      repo: "repo",
      ref: "main",
      path: "skills/foo/SKILL.md",
      kind: "raw",
    })
    expect(parseGithubShorthand("owner/repo")).toMatchObject({ owner: "owner", repo: "repo", kind: "repo" })
  })

  it("parses skills.sh URLs and ignores API paths", () => {
    expect(parseSkillsShUrl("https://skills.sh/owner/repo/blender-animation")).toEqual({
      owner: "owner",
      repo: "repo",
      slug: "blender-animation",
    })
    expect(parseSkillsShUrl("https://skills.sh/api/search?q=x")).toBeUndefined()
  })

  it("parses OpenCode catalog URLs", () => {
    expect(parseCatalogUrl("https://example.com/skills/index.json")?.base).toBe("https://example.com/skills/")
    expect(parseCatalogUrl("https://example.com/skills/")?.base).toBe("https://example.com/skills/")
  })

  it("routes inputs to the right source", () => {
    expect(parseInput("https://github.com/a/b/tree/main/skills/x").type).toBe("github")
    expect(parseInput("a/b").type).toBe("github")
    expect(parseInput("https://skills.sh/a/b/c").type).toBe("skills.sh")
    expect(parseInput("https://example.com/skills/index.json").type).toBe("catalog")
    expect(parseInput("https://example.com/SKILL.md").type).toBe("direct")
    expect(parseInput("blender animation").type).toBe("query")
  })

  it("rejects unsupported URLs", () => {
    expect(() => parseInput("ftp://example.com/SKILL.md")).toThrow()
    expect(() => parseInput("https://example.com/page.html")).toThrow()
    expect(() => parseInput("")).toThrow()
  })
})
