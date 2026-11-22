# Contributing

Thanks for improving the Runtime Skill Manager.

## Development

```bash
npm install
npm run typecheck
npm test
```

The end-to-end test needs a local `opencode` binary and runs a real server against a mock model provider:

```bash
npm run e2e
```

## Pull requests

- Keep the change focused. One behaviour per pull request.
- Add or update a test for every behaviour change. The suite must stay green on Windows and Linux.
- Security-sensitive changes (downloads, paths, install, registration) need a test that proves the failure mode, not only the happy path.
- Do not add `child_process`, `eval`, `new Function`, dynamic imports of downloaded files, or any code path that executes a skill. `tests/no-exec.test.ts` enforces this.
- Update `README.md`, `docs/skill-manager.md` and `CHANGELOG.md` when the public behaviour changes.
- State which OpenCode version and `@opencode/plugin` version you tested against. This project targets OpenCode 2.x; pin the plugin API to the OpenCode release.

## Reporting bugs

Include OpenCode version, OS, the tool call or `/skill-manager` command, the returned JSON, and the relevant lines from `.opencode/skill-manager/activity.log`. Redact tokens and private repository names.

## License

By contributing you agree that your contribution is licensed under the MIT License.
