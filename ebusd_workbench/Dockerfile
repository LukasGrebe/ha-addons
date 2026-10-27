# ARG before any FROM so it can be used in the FROM below (Docker requirement).
# Home Assistant's multi-arch Debian base, the same as the eBUSd app uses.
ARG BUILD_FROM=ghcr.io/home-assistant/base-debian:trixie

FROM ${BUILD_FROM}

ENV LANG C.UTF-8

# python3 (standard library only) runs the backend, git manages the definitions
# repository. Everything else (TypeSpec compiler, ebusd's message decoder) runs
# in the browser, see www/vendor.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      git \
      python3 \
 && rm -rf /var/lib/apt/lists/*

LABEL \
    org.opencontainers.image.title="Home Assistant App: ebusd Config Workbench" \
    org.opencontainers.image.description="Browse recorded eBUS telegrams and work on ebusd message definitions (TypeSpec to CSV) with tests against real bus data" \
    org.opencontainers.image.source="https://github.com/LukasGrebe/ha-addons" \
    org.opencontainers.image.licenses="Apache License 2.0"

COPY workbench /opt/workbench/workbench
COPY www /opt/workbench/www
COPY run.sh git-askpass.sh /
RUN chmod a+x /run.sh /git-askpass.sh
WORKDIR /opt/workbench
CMD ["/run.sh"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
   CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8099/api/health', timeout=3)" || exit 1
