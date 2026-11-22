# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-11-22

First public release.

### Added

- Runtime discovery, inspection, installation, listing and uninstallation of Agent Skills in OpenCode.
- Live registration through `ctx.skill.transform()` and `ctx.skill.reload()`, verified with `ctx.skill.list()`.
- Sources: skills.sh, GitHub (repo/tree/blob/raw/shorthand), direct `SKILL.md`, OpenCode `index.json` catalogs.
- Security analysis for paths, archives, executables, prompt injection, credential access, hidden content and dangerous commands.
- Staged installs with rollback, backups, conflict handling and idempotent reinstalls.
- `/skill-manager` command and six tools: `skill_search`, `skill_inspect`, `skill_install`, `skill_list`, `skill_uninstall`, `skill_status`.
- `skill-discovery` agent skill, also published for the `skills` CLI.
- 49 unit tests and a real-server end-to-end test with a mock model provider.
