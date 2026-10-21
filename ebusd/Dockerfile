# ARG before any FROM so it can be used in the FROM below (Docker requirement).
# Home Assistant's multi-arch Debian base; CI and Supervisor (local builds) both
# build from this Dockerfile alone, there is no build.yaml anymore.
ARG BUILD_FROM=ghcr.io/home-assistant/base-debian:trixie

# Pull ebusd binary and config directly from john30's official multi-arch image.
# Docker automatically selects the right arch variant from the manifest.
# The tag here is kept in sync with config.yaml (single source of truth) by
# update-ebusd.yml, which bumps both files together in each version-bump PR.
FROM john30/ebusd:v26.1 AS upstream

# ttyd: web terminal (xterm.js over WebSocket) served on the HA ingress port.
# Multi-arch image — Docker picks the right variant automatically. Pinned so that
# builds are reproducible; Dependabot proposes updates.
FROM ghcr.io/tsl0922/ttyd:1.7.8 AS ttyd-upstream

FROM ${BUILD_FROM}

ENV LANG C.UTF-8

# Install only the runtime libraries the ebusd binary links against,
# plus python3/sqlite3 for the optional SQLite telegram log (ebus_sqlite.py)
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libmosquitto1 \
      ca-certificates \
      netcat-openbsd \
      python3 \
      sqlite3 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=upstream /usr/bin/ebusd   /usr/bin/ebusd
COPY --from=upstream /usr/bin/ebusctl /usr/bin/ebusctl
COPY --from=upstream /etc/ebusd/      /etc/ebusd/
COPY --from=ttyd-upstream /usr/bin/ttyd /usr/bin/ttyd

LABEL \
    Description="ebusd" \
    org.opencontainers.image.title="Home Assistant App: eBUSd" \
    org.opencontainers.image.description="Transparent wrapper of john30/ebusd — a daemon for communicating with eBUS devices (heating systems)" \
    org.opencontainers.image.source="https://github.com/LukasGrebe/ha-addons" \
    org.opencontainers.image.licenses="Apache License 2.0"

COPY run.sh ebus_sqlite.py /
RUN chmod a+x /run.sh /ebus_sqlite.py
CMD ["/run.sh"]

HEALTHCHECK --interval=10s --timeout=3s --start-period=30s \
   CMD nc -z 127.0.0.1 8888 || exit 1
