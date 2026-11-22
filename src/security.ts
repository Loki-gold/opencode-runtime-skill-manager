import { extensionOf } from "./paths.ts"
import type { SecurityFinding, SecurityReport, SkillFile } from "./types.ts"

const EXECUTABLE_EXTENSIONS = new Set([
  ".exe",
  ".dll",
  ".msi",
  ".msix",
  ".scr",
  ".com",
  ".bat",
  ".cmd",
  ".ps1",
  ".vbs",
  ".vbe",
  ".wsf",
  ".hta",
  ".jar",
  ".so",
  ".dylib",
  ".pkg",
  ".dmg",
  ".deb",
  ".rpm",
  ".apk",
  ".app",
])

const SCRIPT_EXTENSIONS = new Set([".sh", ".bash", ".zsh", ".fish", ".py", ".rb", ".pl", ".js", ".mjs", ".cjs", ".ts", ".php"])

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp", ".avif"])

interface Pattern {
  readonly rule: string
  readonly severity: "warn" | "block"
  readonly regex: RegExp
  readonly message: string
}

const PATTERNS: readonly Pattern[] = [
  {
    rule: "prompt-injection",
    severity: "warn",
    regex: /\b(ignore|disregard|forget)\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)\b/i,
    message: "Text tries to override earlier instructions. Treat the skill as untrusted task guidance.",
  },
  {
    rule: "prompt-injection",
    severity: "warn",
    regex: /\b(new|replacement)\s+system\s+(prompt|instructions?)\b/i,
    message: "Text claims to define a new system prompt.",
  },
  {
    rule: "prompt-injection",
    severity: "warn",
    regex: /\b(you\s+are\s+now|act\s+as|pretend\s+to\s+be)\b.{0,80}\b(admin|root|developer|unrestricted|jailbreak)\b/i,
    message: "Text tries to change the agent role or remove restrictions.",
  },
  {
    rule: "concealment",
    severity: "warn",
    regex: /\b(do\s+not|don't|never)\s+(tell|inform|warn|show)\s+(the\s+)?(user|human|operator)\b/i,
    message: "Text asks the agent to hide something from the user.",
  },
  {
    rule: "concealment",
    severity: "warn",
    regex: /\b(secretly|covertly|without\s+telling|hide\s+this\s+from)\b/i,
    message: "Text suggests covert behaviour.",
  },
  {
    rule: "credential-directory",
    severity: "block",
    regex: /(?:~|\$HOME|\/home\/[^/\s]+|\/Users\/[^/\s]+|%USERPROFILE%|\$env:USERPROFILE)[\\/]\.?(?:ssh|aws|azure|gnupg|kube|docker)[\\/]/i,
    message: "Text references credential directories.",
  },
  {
    rule: "credential-file",
    severity: "warn",
    regex: /\b(?:id_rsa|id_ed25519|credentials\.json|\.aws\/credentials|\.env(?:\.local)?|opencode\.jsonc?|auth\.json)\b/i,
    message: "Text references common credential or configuration files.",
  },
  {
    rule: "environment-access",
    severity: "block",
    regex: /\b(process\.env|os\.environ|getenv\(|printenv|env\s*\|\s*(?:curl|nc|wget)|Get-ChildItem\s+Env:)\b/i,
    message: "Text asks to read or transmit environment variables.",
  },
  {
    rule: "credential-tools",
    severity: "block",
    regex: /\b(keychain|security\s+find-generic-password|cmdkey|Get-Credential|mimikatz|lsass|hashdump)\b/i,
    message: "Text references credential extraction tools.",
  },
  {
    rule: "secret-exfiltration",
    severity: "block",
    regex: /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|nc|netcat|scp|ftp)\b[^\n]{0,200}(?:\$|%|env|token|secret|key|passwd|password|\.ssh|\.env)/i,
    message: "Text combines network upload with secrets or environment data.",
  },
  {
    rule: "dangerous-command",
    severity: "block",
    regex: /\brm\s+-rf\s+(?:\/|~|\$HOME|[a-zA-Z]:\\)/i,
    message: "Destructive recursive delete command.",
  },
  {
    rule: "dangerous-command",
    severity: "block",
    regex: /\b(del|erase)\s+\/[a-z]*[fsq][a-z]*\s+(?:[a-zA-Z]:\\|%SystemRoot%|%USERPROFILE%)/i,
    message: "Destructive Windows delete command.",
  },
  {
    rule: "dangerous-command",
    severity: "block",
    regex: /\b(?:diskpart|cipher\s+\/w|bcdedit|shutdown\s+\/[sr])\b|\bformat\s+(?:[a-zA-Z]:[\\/]|\/dev\/)/i,
    message: "System-destructive command.",
  },
  {
    rule: "dangerous-command",
    severity: "block",
    regex: /\b(reg\s+delete|regedit|Set-MpPreference|netsh\s+advfirewall|schtasks\s+\/create|takeown\s+\/f|icacls\s+.*\/grant)\b/i,
    message: "Command changes system security or persistence settings.",
  },
  {
    rule: "pipe-to-shell",
    severity: "block",
    regex: /\b(?:curl|wget|Invoke-WebRequest|iwr)\b[^\n|]{0,300}\|\s*(?:sudo\s+)?(?:sh|bash|zsh|powershell|pwsh|cmd|iex|Invoke-Expression)\b/i,
    message: "Downloads and executes remote code in one step.",
  },
  {
    rule: "encoded-execution",
    severity: "block",
    regex: /\b(?:powershell|pwsh)\b[^\n]{0,100}\s-(?:enc|encodedcommand)\b|\bbase64\s+(?:-d|--decode)\s*\|\s*(?:sh|bash)\b/i,
    message: "Encoded or obfuscated command execution.",
  },
  {
    rule: "execution-instruction",
    severity: "warn",
    regex: /\b(run|execute|launch|invoke)\b.{0,40}\b(script|binary|executable|\.exe|\.bat|\.ps1|\.sh)\b/i,
    message: "Text asks to execute a script or binary. The manager never runs downloaded files.",
  },
  {
    rule: "chmod-exec",
    severity: "warn",
    regex: /\bchmod\s+\+?x\b/i,
    message: "Text makes a file executable.",
  },
  {
    rule: "system-paths",
    severity: "warn",
    regex: /\b(?:C:\\Windows|C:\\Program Files|\/etc\/|\/usr\/bin\/|\/bin\/|system32)\b/i,
    message: "Text references system paths.",
  },
]

const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/

function isBinary(file: SkillFile): boolean {
  const sample = file.content.slice(0, 4_000)
  if (!sample) return false
  if (sample.includes("\0")) return true
  let control = 0
  for (let index = 0; index < sample.length; index++) {
    const code = sample.charCodeAt(index)
    if (code < 9 || (code > 13 && code < 32)) control++
  }
  return control / sample.length > 0.02
}

function magic(file: SkillFile): string | undefined {
  const bytes = Buffer.from(file.content.slice(0, 4), "utf8")
  if (bytes[0] === 0x4d && bytes[1] === 0x5a) return "MZ"
  if (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) return "ELF"
  if (bytes[0] === 0xca && bytes[1] === 0xfe && bytes[2] === 0xba && bytes[3] === 0xbe) return "Mach-O"
  return undefined
}

function add(
  findings: SecurityFinding[],
  file: SkillFile,
  severity: SecurityFinding["severity"],
  rule: string,
  message: string,
  line?: number,
  excerpt?: string,
) {
  findings.push({
    severity,
    rule,
    file: file.path,
    ...(line === undefined ? {} : { line }),
    message,
    ...(excerpt ? { excerpt: excerpt.slice(0, 240) } : {}),
  })
}

export function analyzeFiles(files: readonly SkillFile[], options: { allowScripts: boolean }): SecurityReport {
  const findings: SecurityFinding[] = []
  const perRule = new Map<string, number>()

  for (const file of files) {
    const extension = extensionOf(file.path)
    const binary = isBinary(file)
    const signature = magic(file)

    if (EXECUTABLE_EXTENSIONS.has(extension) || signature) {
      add(
        findings,
        file,
        "block",
        "executable-file",
        `Executable content is not allowed (${signature ?? (extension || "unknown")}). The manager never runs downloaded files.`,
      )
      continue
    }

    if (SCRIPT_EXTENSIONS.has(extension)) {
      add(
        findings,
        file,
        "warn",
        "script-file",
        options.allowScripts
          ? "Skill contains a script. It is stored as data and never executed automatically."
          : "Skill contains a script. Review it before installing; it is stored as data and never executed automatically.",
      )
    }

    if (binary) {
      if (IMAGE_EXTENSIONS.has(extension)) continue
      add(findings, file, "block", "binary-file", "Binary content is not allowed in a text skill package.")
      continue
    }

    const lines = file.content.replace(/\r\n?/g, "\n").split("\n")
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? ""
      if (!line) continue
      if (ZERO_WIDTH.test(line)) {
        add(findings, file, "warn", "invisible-characters", "Line contains invisible or bidirectional control characters.", index + 1)
      }
      for (const pattern of PATTERNS) {
        const count = perRule.get(`${file.path}:${pattern.rule}`) ?? 0
        if (count >= 5) continue
        if (!pattern.regex.test(line)) continue
        perRule.set(`${file.path}:${pattern.rule}`, count + 1)
        add(findings, file, pattern.severity, pattern.rule, pattern.message, index + 1, line.trim())
      }
      const base64 = line.match(/[A-Za-z0-9+/]{300,}={0,2}/)
      if (base64) {
        add(
          findings,
          file,
          "warn",
          "encoded-blob",
          "Line contains a large base64-like blob that may hide instructions or payloads.",
          index + 1,
          line.trim(),
        )
      }
    }

    const comments = file.content.match(/<!--[\s\S]{0,2000}?-->/g) ?? []
    for (const comment of comments) {
      if (/(ignore|system|secret|token|password|curl|wget|execute|run\s+)/i.test(comment)) {
        add(findings, file, "warn", "hidden-comment", "HTML comment contains suspicious instructions.", undefined, comment)
      }
    }
  }

  const counts = {
    block: findings.filter((item) => item.severity === "block").length,
    warn: findings.filter((item) => item.severity === "warn").length,
    info: findings.filter((item) => item.severity === "info").length,
  }
  return {
    status: counts.block > 0 ? "blocked" : counts.warn > 0 ? "warnings" : "clean",
    findings,
    counts,
  }
}

