# ARG before any FROM so it can be used in the FROM below (Docker requirement)
ARG BUILD_FROM

# Pull ebusd binary and config directly from john30's official multi-arch image.
# Docker automatically selects the right arch variant from the manifest.
# The tag here is kept in sync with config.yaml (single source of truth) by
# update-ebusd.yml, which bumps both files together in each version-bump PR.
FROM john30/ebusd:v26.1 AS upstream

FROM ${BUILD_FROM}

ENV LANG C.UTF-8

# Install only the runtime libraries the ebusd binary links against
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libmosquitto1 \
      ca-certificates \
      netcat-openbsd \
 && rm -rf /var/lib/apt/lists/*

COPY --from=upstream /usr/bin/ebusd   /usr/bin/ebusd
COPY --from=upstream /usr/bin/ebusctl /usr/bin/ebusctl
COPY --from=upstream /etc/ebusd/     /etc/ebusd/

LABEL Description="ebusd"

COPY run.sh /
RUN chmod a+x /run.sh
CMD ["/run.sh"]

HEALTHCHECK --interval=10s --timeout=3s --start-period=30s \
   CMD nc -z 127.0.0.1 8888 || exit 1
