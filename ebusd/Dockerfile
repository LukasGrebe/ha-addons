ARG BUILD_FROM
FROM $BUILD_FROM

ENV LANG C.UTF-8

# Download and install ebusd 26.1 from official Debian packages
# The BUILDPLATFORM is automatically set by Docker buildx
RUN apk add --no-cache ca-certificates curl dpkg && \
    ARCH=$(case "$(apk --print-arch)" in \
        x86_64) echo "amd64" ;; \
        x86) echo "386" ;; \
        aarch64) echo "arm64" ;; \
        armv7l) echo "armv7" ;; \
        armhf) echo "armv7" ;; \
        *) echo "unknown" ;; \
    esac) && \
    curl -L -o /tmp/ebusd.deb "https://github.com/john30/ebusd/releases/download/26.1/ebusd-26.1_${ARCH}-trixie_mqtt1.deb" && \
    dpkg --extract /tmp/ebusd.deb / && \
    rm /tmp/ebusd.deb && \
    apk del --no-cache ca-certificates curl dpkg

LABEL Description="ebusd"

COPY run.sh /
RUN chmod a+x /run.sh
CMD [ "/run.sh" ]

# Health check
HEALTHCHECK --interval=5m --timeout=3s --start-period=90s \
   CMD nc -z 127.0.0.1 8888 || exit 1