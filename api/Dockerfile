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
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/api ./cmd/api

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /out/api /api
# Container Apps ingress targets 8080 (infra/main.bicep); main.go defaults to
# the same, so this is documentation more than configuration.
ENV PORT=8080
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/api"]
