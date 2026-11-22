# Runtime Skill Manager — technical reference

A project-local OpenCode plugin and an agent skill that let the model find, inspect, install and register Agent Skills while OpenCode is running.

Tested against **OpenCode 2.2.7** with **`@opencode/plugin@2.2.7`**.

## What it does

- Searches **skills.sh**, **GitHub**, direct `SKILL.md` URLs and OpenCode HTTP catalogs (`index.json`).
- Inspects a candidate before installing: frontmatter, file tree, compatibility, quality signals, security findings, conflicts.
- Installs into the current project at `.opencode/skills/<id>/SKILL.md`, preserving supporting files.
- Registers the skill live with `ctx.skill.transform()` + `editor.add()` + `ctx.skill.reload()`.
- Verifies the registration through `ctx.skill.list()`.
- Removes managed skills with a backup.
- Never executes downloaded scripts or commands.

The downloaded skill becomes available to the **next model step**. The request that triggered the install keeps the context it already captured. OpenCode announces the change with an "available skills have changed" instruction.

## Files

```text
.
├── index.ts                  plugin entry, tools, hooks, command
├── src/                      sources, security, install, registry, ...
├── skills/skill-discovery/   the managing skill (also published to skills.sh)
├── docs/skill-manager.md     this file
├── tests/                    unit tests
└── scripts/
    └── skill-manager-e2e.mjs real OpenCode + mock provider end-to-end test
```

Runtime state:

```text
.opencode/
  skills/<id>/                installed skills
  skill-manager/
    config.json               optional user config
    registry.json             runtime state (generated)
    activity.log              runtime event log (generated)
    backups/                  install backups (generated)
    tmp/                      staging area (generated)
```

## Activation

Add the plugin directory to `opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["../opencode-runtime-skill-manager"]
}
```

A directory under `.opencode/plugins/` loads automatically. Plugins are loaded on setup; after adding one to a running server, run `/reload` or start a new session. A full process restart is not required.

Check that the plugin and skill are visible:

```bash
opencode api get /api/plugin
opencode api get /api/skill
```

The tools appear in the `skill` namespace:

- `skill_search`
- `skill_inspect`
- `skill_install`
- `skill_list`
- `skill_uninstall`
- `skill_status` (diagnostics)

In Code Mode they are called as `tools.skill.search(...)`, etc.

## Tools

### `skill_search`

```json
{ "query": "blender character animation", "source": "auto", "limit": 8 }
```

`source`: `auto`, `all`, `skills.sh`, `github`.

Returns candidates with:

- name and description;
- source URL and repository;
- `installs` only from skills.sh;
- `stars`, `license`, `repoLastPush` only from the GitHub API;
- OpenCode compatibility;
- a heuristic quality score **with the signals that produced it**;
- an `inspectToken` for candidates that were pre-fetched.

Unavailable metrics are `null`. The manager does not invent install counts, stars or dates.

### `skill_inspect`

```json
{ "token": "sm_..." }
```

or

```json
{ "source": "https://github.com/owner/repo/tree/main/skills/foo" }
```

Returns the full `SKILL.md` preview, file tree, hashes, compatibility, quality, security findings, conflicts and a fresh `inspectToken`. Writes nothing.

### `skill_install`

```json
{ "token": "sm_...", "overwrite": "error", "allowWarnings": false }
```

Or pass `source`, `path`, `ref`, `name` directly.

- Requires confirmation by default.
- Refuses blocked security findings.
- Requires `allowWarnings: true` for warnings (for example, a skill that ships a Python helper).
- `overwrite`:
  - `error` (default) — refuse a different version or an unmanaged directory;
  - `replace` — back up the managed skill and update it;
  - `replace-unmanaged` — also replace a directory not tracked by the registry.
- Reinstalling identical content is idempotent.
- Returns `registered`, `verified`, `advertised` and `availableIn: "next model step"`.

### `skill_list`

Lists project, global and built-in skills with:

- scope (`project`, `global`, `builtin`);
- path;
- managed / registered / advertised state;
- source, install time, security summary;
- `modified` (SKILL.md changed after install);
- `missing` (registry entry without a directory).

### `skill_uninstall`

```json
{ "id": "foo", "purge": false }
```

- Managed skills only, unless `force: "unmanaged"`.
- Moves files to `.opencode/skill-manager/backups/` by default.
- Reloads the registry and gives the config watcher a moment to drop its stale entry.
- If another source still provides the same id, it is reported.

### `skill_status`

Shows version, paths, counts and effective configuration.

## Command

For manual use and deterministic tests:

```text
/skill-manager search blender animation
/skill-manager inspect https://github.com/owner/repo/tree/main/skills/foo
/skill-manager install --token=sm_...
/skill-manager list
/skill-manager uninstall foo
/skill-manager status
```

## Dynamic registration algorithm

1. Download into a staging directory under `.opencode/skill-manager/tmp/`.
2. Validate paths, frontmatter, size limits and security.
3. Atomically move into `.opencode/skills/<id>/`.
4. Parse `SKILL.md` into `Skill.Info`:
   ```ts
   { id, name, description?, autoinvoke?, path, content }
   ```
   `content` is the Markdown body without frontmatter; `path` is the absolute `SKILL.md`.
5. Add the skill to the plugin's mutable map.
6. The transform registered in `setup()` calls `editor.add()`:
   ```ts
   await ctx.skill.transform((editor) => {
     for (const skill of registered.values()) editor.add(toInfo(skill))
   })
   ```
7. `await ctx.skill.reload()` replays the transform against fresh state.
8. `await ctx.skill.list()` must contain the id and matching content.
9. `registry.json` is updated.
10. The result says `availableIn: "next model step"`.

A single transform with a mutable map is used instead of one transform per install. It avoids accumulating registrations and is the documented transform pattern. `ctx.skill.reload()` re-runs it.

OpenCode also watches `.opencode/skills`; both the transform and the file watcher converge on the same registry.

## Sources

### skills.sh

Uses the public endpoints used by the official `skills` CLI:

- `GET https://skills.sh/api/search?q=...`
- `GET https://skills.sh/api/download/<owner>/<repo>/<slug>`

The official `/api/v1/*` API requires Vercel OIDC and is not used.

### GitHub

Supports repository, tree, blob and raw URLs plus `owner/repo` shorthand. Reads repo metadata and the recursive tree through the GitHub API, then downloads only the selected skill directory through raw URLs. It does not clone the repository.

Without `GITHUB_TOKEN`, the public GitHub API allows 60 requests/hour. Set `GITHUB_TOKEN` (or `githubTokenEnv`) for more and for code search.

For a repository-root skill, only `SKILL.md`, root `*.md` and known resource directories are included (`references/`, `scripts/`, `assets/`, `templates/`, `examples/`, `docs/`, `resources/`). This avoids installing an entire application repository.

### Direct `SKILL.md`

A single Markdown file is installed as `SKILL.md`. Supporting files cannot be discovered generically; the result includes a warning. Use a GitHub tree URL when supporting files matter.

### OpenCode catalogs

```json
{
  "skills": [
    { "name": "my-skill", "version": "1", "files": ["SKILL.md", "references/guide.md"] }
  ]
}
```

Files are fetched from `<base>/<name>/<file>`. Paths must be relative and same-origin.

## Security

Downloaded skills are untrusted data.

- HTTPS by default; private/local hosts blocked unless `allowPrivateHosts`.
- Path traversal, absolute paths, drive letters, backslashes, reserved Windows names and URL paths are rejected.
- File count/size/depth limits.
- Executable extensions and magic bytes are blocked.
- Scripts are warnings, stored as data, and never executed.
- Prompt injection, concealment, credential access, environment exfiltration, dangerous commands, `curl | sh`, encoded PowerShell, invisible characters and hidden HTML comments produce findings.
- Blocking findings cannot be overridden.
- Files are staged, backed up and rolled back on failure.
- Only the skill name and description are advertised; the body is loaded through the normal `skill` tool.
- The plugin never imports `child_process`, never spawns processes, and never evaluates downloaded content.

See [`skills/skill-discovery/references/security.md`](../skills/skill-discovery/references/security.md).

## Tests

Unit tests:

```bash
npx vitest run
```

49 tests cover frontmatter, paths, URL safety, security findings, source parsing, download limits/retries/timeouts, install/uninstall/rollback/conflicts, registry corruption, and a source scan that proves there is no execution code.

End-to-end test with a real OpenCode server, a local fixture catalog, a local mock OpenAI-compatible provider and no network dependency:

```bash
npm run e2e
```

It verifies:

1. Plugin loads in a temp project.
2. `skill-discovery` is registered.
3. Install writes files, updates the registry and appears in `/api/skill`.
4. The **next model request** contains the installed skill in the available-skills guidance (captured by the mock provider).
5. Uninstall removes it and keeps a backup.
6. Reinstall is idempotent.
7. A malicious skill is blocked.
8. An invalid URL fails closed.
9. An unmanaged directory is not overwritten.

Type-check the plugin:

```bash
npm install
npm run typecheck
```

## Troubleshooting

| Symptom | Check |
|---|---|
| Tools are missing | `opencode api get /api/plugin`; run `/reload`; start a new session. |
| `skill-discovery` missing | `opencode api get /api/skill`; check `.opencode/skills/skill-discovery/SKILL.md` or the global skills directory. The plugin ships a built-in fallback. |
| Skill installed but not advertised | It has no `description`, `metadata.opencode/autoinvoke: false`, or the agent's `skill` permission denies it. |
| `VERIFICATION_FAILED` | Check the OpenCode server log and agent skill permissions; files may be present but registration failed. |
| GitHub rate limit | Wait for `X-RateLimit-Reset`, or set `GITHUB_TOKEN`. |
| skills.sh package has no snapshot | Install from the GitHub repository instead. |
| Windows `EBUSY`/`EPERM` | The manager retries renames; close editors/antivirus locks and retry. |
| Config change ignored | Config is read at plugin setup; run `/reload` or start a new session. |

## Known limitations

- The public skills.sh endpoints are the same ones the official CLI uses, but they are not a documented stable API. Fallbacks exist.
- GitHub unauthenticated limits are low. Caching and tokens help.
- `stars` and `pushed_at` are repository-wide metrics, not per-skill metrics.
- A model can still choose not to search in implicit cases. The plugin guarantees tools, the managing skill, a prompt attachment for explicit requests, and a short system guidance block.
- The API is plugin-specific. Pin `@opencode/plugin` to the OpenCode version and rerun the e2e test when upgrading.
- Installs are project-local. Global and built-in skills are visible but never modified.
