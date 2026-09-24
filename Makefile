# Convenience targets mirroring the CI workflows (see .github/workflows/).
# Requires: bats, shellcheck (both `apt-get install -y bats shellcheck`, or
# use the provided devcontainer).

.PHONY: test lint

test:
	bats tests/

lint:
	shellcheck ebusd/run.sh tests/mocks/bashio.sh tests/mocks/bin/*
