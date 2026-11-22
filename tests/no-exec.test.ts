import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"

const root = process.cwd()
const pluginRoot = path.join(root, "src")

async function sourceFiles(directory: string): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) result.push(...(await sourceFiles(target)))
    else if (entry.isFile() && entry.name.endsWith(".ts")) result.push(target)
  }
  return result
}

describe("no downloaded code execution", () => {
  it("plugin source never imports child_process or evaluates strings", async () => {
    const files = [path.join(root, "index.ts"), ...(await sourceFiles(pluginRoot))]
    expect(files.length).toBeGreaterThan(5)
    const forbidden = [
      /\bchild_process\b/,
      /\bexecSync\s*\(/,
      /\bexecFileSync\s*\(/,
      /\bspawnSync\s*\(/,
      /\bspawn\s*\(/,
      /\bshell\s*:\s*true\b/,
      /\bnew\s+Function\s*\(/,
      /\beval\s*\(/,
    ]
    for (const file of files) {
      const text = await readFile(file, "utf8")
      for (const pattern of forbidden) {
        expect(pattern.test(text), `${path.relative(root, file)} matched ${pattern}`).toBe(false)
      }
    }
  })
})
