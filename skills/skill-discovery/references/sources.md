# Skill Sources

## Source priority

1. An installed skill that already matches the task.
2. `skills.sh` for ecosystem search and install counts.
3. GitHub for direct repositories, monorepos, and `SKILL.md` files.
4. An OpenCode HTTP catalog (`index.json`) when the project provides one.
5. A direct `SKILL.md` URL for a single-file skill.

## skills.sh

The manager uses the public endpoints used by the official `skills` CLI:

- Search: `GET https://skills.sh/api/search?q=<query>`
- Package: `GET https://skills.sh/api/download/<owner>/<repo>/<slug>`

The package response contains the skill's files, so inspect and install use the same snapshot. The official `/api/v1/*` API requires Vercel OIDC; it is not used here.

If a skills.sh entry has no file snapshot, install it from its GitHub repository instead. Do not fabricate a package.

## GitHub

Supported inputs:

- `https://github.com/owner/repo`
- `https://github.com/owner/repo/tree/<ref>/<path>`
- `https://github.com/owner/repo/blob/<ref>/<path>/SKILL.md`
- `https://raw.githubusercontent.com/owner/repo/<ref>/<path>/SKILL.md`
- `owner/repo`

The manager reads repository metadata and the recursive git tree through the GitHub API, then downloads only the selected skill directory through raw URLs. It does not clone the repository.

Limits:

- Unauthenticated GitHub API: 60 requests per hour.
- With `GITHUB_TOKEN` (or the configured `githubTokenEnv`): higher limit and code search.
- Repository stars and `pushed_at` are repository-wide metrics, not per-skill metrics.
- For a monorepo, provide the skill directory path. If several `SKILL.md` files exist, the manager returns candidates instead of guessing.

For a skill at the repository root, only `SKILL.md`, root `*.md`, and files under `references/`, `scripts/`, `assets/`, `templates/`, `examples/`, `docs/`, and `resources/` are included. This avoids installing an entire application repository.

## OpenCode HTTP catalogs

A catalog is a base URL with `index.json`:

```json
{
  "skills": [
    {
      "name": "my-skill",
      "version": "1",
      "files": ["SKILL.md", "references/guide.md"]
    }
  ]
}
```

Files are fetched from `<base>/<name>/<file>`. Paths must be relative and same-origin.

## Direct files

A direct `SKILL.md` URL yields one file. Supporting files cannot be discovered generically, so the result includes a warning. If the host is GitHub, use the GitHub resolver instead.

## Compatibility notes

- OpenCode IDs come from the path. The manager normalizes the directory name to lowercase kebab-case.
- A description is required for the model to see the skill in `<available_skills>`.
- `metadata.opencode/autoinvoke: false` hides the skill from the model's list; it can still be loaded by ID.
- `disable-model-invocation: true` behaves the same way.
- Portability fields such as `license` and `compatibility` are preserved but not interpreted by OpenCode.
