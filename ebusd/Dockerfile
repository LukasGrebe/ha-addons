ARG BUILD_FROM
FROM $BUILD_FROM

ENV LANG C.UTF-8

RUN mkdir -p /etc/apt/keyrings && wget -q -O /etc/apt/keyrings/ebusd.gpg \
    https://raw.githubusercontent.com/john30/ebusd-debian/master/ebusd.gpg

RUN wget -O /etc/apt/sources.list.d/ebusd.list \
    https://raw.githubusercontent.com/john30/ebusd-debian/master/ebusd-default-bookworm.list

RUN apt-get update

RUN apt-get install ebusd

RUN apt-get clean

LABEL Description="ebusd"

COPY run.sh /
RUN chmod a+x /run.sh
CMD [ "/run.sh" ]

# Health check
HEALTHCHECK --interval=5m --timeout=3s --start-period=90s \
   CMD nc -z 127.0.0.1 8888 || exit 1
