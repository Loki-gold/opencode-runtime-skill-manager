import { createHash } from "node:crypto"
import type { SkillFile } from "./types.ts"

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

export function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n")
}

export function hashFiles(files: readonly SkillFile[]): string {
  const hash = createHash("sha256")
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path)
    hash.update("\0")
    hash.update(normalizeText(file.content))
    hash.update("\0")
  }
  return hash.digest("hex")
}

export function makeFile(filePath: string, content: string): SkillFile {
  return {
    path: filePath,
    content,
    bytes: Buffer.byteLength(content, "utf8"),
    sha256: sha256(content),
  }
}
