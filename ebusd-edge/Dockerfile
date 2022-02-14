ARG BUILD_FROM
FROM $BUILD_FROM

ENV LANG C.UTF-8

RUN apk add --no-cache mosquitto-libs libgcc libstdc++

RUN apk add --no-cache --virtual .build-deps \
    build-base \
    argp-standalone \
    git \
    cmake \
    mosquitto-dev \
    openssl-dev

RUN git clone https://github.com/john30/ebusd.git && \
    cd ebusd && \
    cmake -B build \
          -DCMAKE_INSTALL_PREFIX=/usr \
	  -DCMAKE_BUILD_TYPE=MinSizeRel \
          -DBUILD_TESTING=ON && \
    cmake --build build && \
    cmake --install build && \
    mkdir /etc/ebusd && \
    cp contrib/etc/ebusd/mqtt*.cfg /etc/ebusd/ && \
    apk del .build-deps

LABEL Description="eBUSd edge"

COPY run.sh /
RUN chmod a+x /run.sh
CMD [ "/run.sh" ]
