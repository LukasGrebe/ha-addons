# ARG before any FROM so it can be used in the FROM below (Docker requirement).
# Home Assistant's multi-arch Debian base, the same as the eBUSd app uses.
ARG BUILD_FROM=ghcr.io/home-assistant/base-debian:trixie

FROM ${BUILD_FROM}

ENV LANG C.UTF-8

# python3 (standard library only) runs the backend: it serves the telegram database and
# fetches definition sources from GitHub over HTTPS (no git). Everything else (the TypeSpec
# compiler for pull requests, ebusd's message decoder) runs in the browser, see www/vendor.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      python3 \
 && rm -rf /var/lib/apt/lists/*

LABEL \
    org.opencontainers.image.title="Home Assistant App: ebusd Config Workbench" \
    org.opencontainers.image.description="Find the ebusd message definitions that fit your eBUS devices: the recorded telegrams next to every definition that decodes them, from the release, the upcoming release, pull requests and your own" \
    org.opencontainers.image.source="https://github.com/LukasGrebe/ha-addons" \
    org.opencontainers.image.licenses="Apache License 2.0"

COPY workbench /opt/workbench/workbench
COPY www /opt/workbench/www
COPY run.sh /
RUN chmod a+x /run.sh
WORKDIR /opt/workbench
CMD ["/run.sh"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
   CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8099/api/health', timeout=3)" || exit 1
