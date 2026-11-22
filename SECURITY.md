# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 1.x | Yes |

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting on this repository (Security → Report a vulnerability) or contact the maintainer through the profile at [github.com/Loki-gold](https://github.com/Loki-gold).

Include:

- affected version and OpenCode version;
- the source URL used for the malicious or malformed skill;
- the expected and actual result;
- whether files were written before the failure.

You can expect an acknowledgement within 7 days.

## Threat model

The manager downloads third-party content. The primary threats are:

1. **Path escape** — writing outside `.opencode/skills/<id>/`.
2. **Code execution** — a downloaded script or binary being run.
3. **Prompt injection** — skill content instructing the agent to exfiltrate secrets or change its rules.
4. **Supply-chain substitution** — replacing an existing skill with different content.
5. **Resource exhaustion** — huge or deeply nested packages.

Controls are documented in [docs/skill-manager.md](docs/skill-manager.md#security) and in [skills/skill-discovery/references/security.md](skills/skill-discovery/references/security.md). Blocking findings cannot be overridden; scripts are never executed.

Out of scope: the trustworthiness of third-party skills themselves. The manager reports findings and requires confirmation, but the user remains responsible for what they approve.
