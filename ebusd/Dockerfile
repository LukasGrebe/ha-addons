ARG BUILD_FROM
FROM $BUILD_FROM
LABEL org.opencontainers.image.source https://github.com/lukasgrebe/ha-addons
LABEL org.opencontainers.image.name "ghcr.io/lukasgrebe/ha-addons/ebusd-${BUILD_ARCH}"


ENV LANG C.UTF-8

RUN echo "https://dl-cdn.alpinelinux.org/alpine/edge/community" \
    >> /etc/apk/repositories
RUN echo "https://dl-cdn.alpinelinux.org/alpine/edge/main" \
    >> /etc/apk/repositories

RUN apk -U add --no-cache ebusd

LABEL Description="ebusd"

COPY run.sh /
RUN chmod a+x /run.sh
CMD [ "/run.sh" ]
