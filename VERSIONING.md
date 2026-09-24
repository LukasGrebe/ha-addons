# Versioning

`ebusd/config.yaml`'s `version` field is the single source of truth. It is
what Home Assistant Supervisor shows to users, what triggers an update
notification, and what the built image gets tagged with when `builder.yaml`
publishes on merge to `main`.

## Version format: `<upstream-major.minor>.<patch>`

```
26.1.8
└┬┘ │ └ addon patch — bumped for addon-only changes (run.sh, config.yaml
 │  │                 schema, Dockerfile layers other than the ebusd COPY,
 │  │                 translations, DOCS.md)
 │  └── upstream ebusd minor release this build wraps (john30/ebusd v26.1)
 └───── upstream ebusd major release
```

The first two components always mirror the upstream
[john30/ebusd](https://github.com/john30/ebusd) release this build wraps
(`ebusd/Dockerfile`'s `FROM john30/ebusd:v26.1` tag). The third component is
this repo's own patch counter for that upstream version.

## Two ways a version bump happens

1. **Upstream ebusd release** — the weekly
   [`update-ebusd.yml`](.github/workflows/update-ebusd.yml) workflow checks
   `john30/ebusd`'s latest release, and if it differs from `config.yaml`,
   opens a PR that bumps `config.yaml`'s version and `Dockerfile`'s `FROM`
   tag together (`X.Y.0` — patch resets to 0), and prepends the upstream
   changelog section to `ebusd/CHANGELOG.md`. Review and merge like any PR;
   don't hand-edit the version or changelog in that PR.

2. **Addon-only change** (a `run.sh` fix, a `config.yaml` schema tweak, a new
   translation, a Dockerfile change unrelated to the ebusd binary) — bump the
   **patch** component yourself in the same PR:
   - `ebusd/config.yaml`: `version: "26.1.9"`
   - `ebusd/CHANGELOG.md`: add a new top entry:
     ```markdown
     # 26.1.9 (YYYY-MM-DD)

     ## Bug Fixes
     * Fix ... (fixes #123)
     ```
     Use `## Bug Fixes`, `## Features`, or `## App Changes` as a heading,
     matching the style already used throughout the file — these sections
     are addon-specific and sit alongside (not inside) the upstream sections
     `update-ebusd.yml` prepends for actual ebusd releases.

Don't bump the major/minor components yourself — those only ever come from
`update-ebusd.yml` tracking an actual upstream release.

## Publishing

Merging to `main` is what ships a release: `builder.yaml` builds and pushes
`ghcr.io/lukasgrebe/ha-addon-ebusd-{arch}` tagged with `config.yaml`'s
current `version`. There's no separate manual tagging step — get the version
bump right in the PR, and merging does the rest.
