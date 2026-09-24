## What & why

<!-- What does this change, and what problem does it solve? Link any related issue. -->

## How was this tested?

<!--
- run.sh change: which bats test(s) cover it? `make test` output green?
- config.yaml / Dockerfile / build.yaml change: how did you verify it locally
  (e.g. built the image, ran `tester.yaml`'s matrix locally, installed on a
  real Supervisor)?
-->

## Version bump

- [ ] Not needed (docs/CI-only change, or this is an automated `update-ebusd.yml`/Dependabot PR)
- [ ] `ebusd/config.yaml` version bumped and `ebusd/CHANGELOG.md` updated — see [VERSIONING.md](../VERSIONING.md)

## Checklist

- [ ] `make lint` passes (shellcheck)
- [ ] `make test` passes (bats)
