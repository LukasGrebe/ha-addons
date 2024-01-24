ARG BUILD_FROM
FROM $BUILD_FROM

ENV LANG C.UTF-8

RUN echo "https://dl-cdn.alpinelinux.org/alpine/edge/community" \
    >> /etc/apk/repositories
RUN echo "https://dl-cdn.alpinelinux.org/alpine/edge/main" \
    >> /etc/apk/repositories

#RUN apk add --no-cache ebusd=23.2-r0
#Temporal block for v23.3 -->
WORKDIR /
ADD https://github.com/LukasGrebe/ha-addons/blob/7a3c1113f2777ee7fdaa15b1157b626b91b5f58b/alpine/ebusd-23.3-prebuilt.apk /ebusd-23.3-prebuilt.apk
RUN apk add --no-cache ebusd-23.3-prebuilt.apk
#<--End of temporal block

LABEL Description="ebusd"

COPY run.sh /
RUN chmod a+x /run.sh
CMD [ "/run.sh" ]

# Health check
HEALTHCHECK --interval=5m --timeout=3s --start-period=90s \
   CMD nc -z localhost 8888 || exit 1
