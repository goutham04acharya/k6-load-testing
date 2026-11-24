# Load Testing k6 runner: the official k6 binary plus a start script that downloads the
# test, waits for the shared start time, runs its segment and uploads results.
ARG K6_VERSION=2.4.0
FROM grafana/k6:${K6_VERSION} AS k6

FROM alpine:3.22
RUN apk add --no-cache aws-cli bash ca-certificates coreutils curl jq tini \
 && adduser -D -u 10001 runner \
 && mkdir /work && chown runner /work
COPY --from=k6 /usr/bin/k6 /usr/bin/k6
COPY entrypoint.sh /entrypoint.sh
RUN chmod 0755 /entrypoint.sh
USER runner
WORKDIR /work
ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]
