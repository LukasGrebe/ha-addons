# Contributing

Thanks for helping! This repository packages [ebusd](https://github.com/john30/ebusd) as a
Home Assistant app. Questions about ebusd itself, message definitions (CSV) or your heating
system belong to the [ebusd project](https://github.com/john30/ebusd/discussions).

## Branches

| Branch | Purpose |
|---|---|
| `main` | The live version: Home Assistant installs the app from here. Only release PRs (`release/*`) and urgent fixes (`hotfix/*`) are merged into it. |
| `next` | The upcoming version. All other PRs go here; PRs opened against `main` are moved to `next` automatically. |
| `channel-next`, `channel-pr-<N>` | Generated test channels (see below). Don't edit them. |

## Pull requests

1. Branch from `next` and open the PR against `next`.
2. Describe user-visible changes in `ebusd/CHANGELOG.md` under `# Unreleased`
   (create the section at the top if it is missing). Don't change the version in
   `ebusd/config.yaml`; it is set when releasing.
3. New or changed options: update the schema in `ebusd/config.yaml`, **all** files in
   `ebusd/translations/` (CI checks that every option has a name and a description) and
   `ebusd/DOCS.md`.
4. CI must pass: lint (add-on linter, shellcheck, translations), the build for amd64 and
   aarch64, and the end-to-end tests on both.
5. Try it in your Home Assistant: the PR gets a comment with a link that installs it as a
   separate test app **eBUSd (PR #N)**. PRs from this repository get it on every push; PRs
   from forks once a maintainer has read the diff and added the label `preview` (remove
   and add it again to update the preview).

## Tests

The end-to-end tests (`tests/e2e/run.py`) start the app image the way Supervisor does and
run it against a fake Supervisor API, simulated eBUS adapters (`tests/e2e/fake_bus.py`:
USB on a pseudo terminal and network on TCP, each with plain and enhanced protocol) and a
Mosquitto broker. They need Linux with Docker and root (the fake Supervisor listens on
port 80):

```bash
docker build -t ebusd-test ebusd
sudo python3 tests/e2e/run.py ebusd-test                        # all tests
sudo python3 tests/e2e/run.py ebusd-test Adapters.test_usb_plain # a single test
```

There is no real eBUS hardware in CI. If you change how ebusd talks to adapters, also try
the preview with a real adapter and say so in the PR.

## Testing upcoming versions

Everything merged into `next` is built, tested and published as test app
**eBUSd (next)**, installable from `https://github.com/LukasGrebe/ha-addons#channel-next`
(see [DOCS.md](ebusd/DOCS.md#testing-upcoming-versions)). Please give it a try and report
problems before a release.

## Releases (maintainers)

1. **Actions → Prepare release → Run workflow.** The version defaults to the version on
   `next` if it is not released yet (e.g. after an ebusd update), else the next patch
   version. The workflow opens the PR `release/<version> → main` with the version set and
   `# Unreleased` turned into the release section of the changelog.
2. Merge the release PR with **Create a merge commit** (not squash) once CI is green.
   A squash commit has no shared history with `next`, so merging `main` back into
   `next` conflicts as soon as a file of this release changed on `next` meanwhile.
3. `release.yaml` publishes the images of the new version (a published version is never
   overwritten), tags it, creates the GitHub release from the changelog and merges `main`
   back into `next` (or opens a PR for that if it cannot).

- **Urgent fix:** branch `hotfix/<name>` from `main`, set the next patch version and a
  changelog section in the PR, open it against `main`. After the merge, `release.yaml`
  does the rest.
- **ebusd updates:** `update-ebusd.yml` checks weekly for a new ebusd release and opens a
  PR against `next` once its Docker images are published.

Dependabot, scheduled workflows and the **Run workflow** button use the workflow files on
`main`, so changes to them take effect with the next release. The first release with this
process is prepared by hand: open a PR `next → main` that sets the version and renames
`# Unreleased`.

### One-time repository settings

- Settings → Actions → General: enable **Allow GitHub Actions to create and approve pull
  requests** (needed by *Prepare release*, *Update ebusd* and the merge back into `next`).
- Settings → Actions → General → Fork pull request workflows: require approval only for
  **first-time contributors who are new to GitHub**, so contributors' PRs get tested.
- Settings → General: enable **Automatically delete head branches**.
- Rulesets for `main` and `next`: require a pull request and the status checks `Lint`,
  `Build / Build and test amd64` and `Build / Build and test aarch64`. For `main`, allow
  only merge commits.
- Create the label `preview` (for previews of fork PRs).
