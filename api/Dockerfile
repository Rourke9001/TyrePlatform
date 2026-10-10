# Build and runtime are separate stages. The runtime image carries only a
# static binary: no shell, no libc, no package manager. There is nothing to
# exploit or patch in the final layer.
FROM golang:1.24-alpine@sha256:8bee1901f1e530bfb4a7850aa7a479d17ae3a18beb6e09064ed54cfd245b7191 AS build
WORKDIR /src
# go.sum comes with go.mod, before the rest of the tree: without it the cached
# module fetch has no checksums to verify against, so this layer would accept
# whatever the proxy served (TYRE-50).
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# CGO off makes the binary fully static so it runs on distroless/static.
# No -tags devheader: the release binary has no dev header resolver (U103).
# The deploy passes its commit (deploy.yml); /readyz reports it (TYRE-79).
ARG BUILD_SHA=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.buildSHA=${BUILD_SHA}" -o /out/api ./cmd/api
# U103: the image does not build if the binary it ships names a dev header.
# The control is the devheader build, kept out of /out.
RUN CGO_ENABLED=0 go build -tags devheader -trimpath -ldflags='-s -w' -o /tmp/control ./cmd/api \
 && sh scripts/check-release-binary.sh /out/api /tmp/control

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /out/api /api
# Container Apps ingress targets 8080 (infra/app.bicep); main.go defaults to
# the same, so this is documentation more than configuration.
ENV PORT=8080
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/api"]
