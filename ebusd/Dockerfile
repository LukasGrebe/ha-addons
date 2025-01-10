ARG BUILD_FROM
FROM $BUILD_FROM

ENV LANG C.UTF-8

RUN apk add --no-cache ebusd=24.1-r0

LABEL Description="ebusd"

COPY run.sh /
RUN chmod a+x /run.sh
CMD [ "/run.sh" ]

# Health check
HEALTHCHECK --interval=5m --timeout=3s --start-period=90s \
   CMD nc -z 127.0.0.1 8888 || exit 1
