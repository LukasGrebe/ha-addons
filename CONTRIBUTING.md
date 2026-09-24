# Contributing

Thanks for taking the time to contribute. This repo currently hosts a single
Home Assistant add-on, [`ebusd`](ebusd/), a thin, transparent wrapper around
[john30/ebusd](https://github.com/john30/ebusd).

## Repository layout

```
ebusd/
  Dockerfile        builds the add-on image (pulls the ebusd binary + ttyd from upstream)
  run.sh             entrypoint: validates options.json, builds ebusd's argv, execs ebusd
  config.yaml        Home Assistant add-on manifest (version, schema, ports, …)
  build.yaml         base images / OCI labels used by the Home Assistant builder
  DOCS.md            end-user documentation shown in the Supervisor UI
  CHANGELOG.md       shown in the Supervisor UI; see "Versioning" below
tests/
  run.bats           behavioural tests for run.sh (bats-core)
  mocks/             stand-ins for bashio, ebusd and ttyd used only by tests
.github/workflows/   CI: lint, test, build/test-build, publish, dependabot ebusd-version bumps
```

## Local setup

The fastest path is the provided devcontainer (`.devcontainer.json`), which
gives you a full Supervisor test environment. For working on `run.sh` alone
you only need `bash`, `jq`, `bats`, and `shellcheck`:

```console
sudo apt-get install -y bats shellcheck
make lint   # shellcheck ebusd/run.sh and the test mocks
make test   # bats tests/
```

Both also run in CI on every push and pull request (`.github/workflows/test.yaml`
and `lint.yaml`).

## Making a change to `run.sh`

`run.sh` is the addon's entrypoint: it reads `/data/options.json`, validates
it (duplicate/malformed flags, deprecated keys, `--configpath` sanity), builds
the `ebusd` argument list, and `exec`s into `ebusd`. Because it only runs
inside a Supervisor container in production, the test suite fakes that
environment:

- `tests/mocks/bashio.sh` provides just-enough stand-ins for the `bashio::*`
  functions `run.sh` calls (`bashio::log.*`, `bashio::config.*`,
  `bashio::services*`), backed by a fixture `options.json` instead of the
  real Supervisor API.
- `tests/mocks/bin/ebusd` replaces the real `ebusd` binary — since `run.sh`
  ends with `exec ebusd "$@"`, this mock becomes the test process and simply
  prints the args it received (`MOCK_EBUSD_ARGS: ...`) so tests can assert on
  the final command line.
- `run.sh` reads its paths (`/data/options.json`, `/config/mqtt-hassio.cfg`,
  `/etc/ebusd/mqtt-hassio.cfg`) through `OPTIONS_JSON_PATH`, `EBUSD_CONFIG_DIR`
  and `EBUSD_ETC_DIR` env vars, defaulting to those HA paths in production.
  Tests point them at a throwaway temp directory so the suite never touches
  your real filesystem.

If you change `run.sh`'s behavior:

1. Add or update a case in `tests/run.bats` that exercises it end-to-end
   (write an `options.json` fixture via the `write_options` helper, run
   `run.sh`, assert on the resulting `MOCK_EBUSD_ARGS:` line and/or log
   output).
2. Run `make lint && make test` locally before opening a PR.
3. Add an entry under a new "App Changes" section at the top of
   `ebusd/CHANGELOG.md` and bump `ebusd/config.yaml`'s `version` — see
   [Versioning](#versioning) below.

Changes to `config.yaml`'s schema, `Dockerfile`, or `build.yaml` don't have
bats coverage yet; `.github/workflows/lint.yaml` (the Home Assistant add-on
linter) and `tester.yaml` (a real multi-arch build) are the safety net there.
A PR that touches those files should describe how it was tested manually
(e.g. "installed the built image locally and confirmed X").

## Versioning

See [VERSIONING.md](VERSIONING.md) for how `ebusd/config.yaml`'s `version`
field is structured and when to bump it.

## Pull requests

- Keep PRs focused on one change; unrelated cleanup makes review harder.
- Fill in the PR template — it asks what changed, why, and how it was tested.
- CI must be green: `lint.yaml` (Home Assistant add-on linter), `test.yaml`
  (shellcheck + bats), and `tester.yaml` (multi-arch build) all run on every
  PR.
- Dependabot-authored PRs (GitHub Actions bumps, the weekly `update-ebusd.yml`
  upstream-version PR) are reviewed the same way as any other PR — CI green
  is required before merge.

## Reporting bugs / requesting features

Use the issue templates (`.github/ISSUE_TEMPLATE/`) — they ask for the
information needed to reproduce a bug (addon version, `commandline_options`,
relevant Supervisor log lines) up front, which saves a round trip.
