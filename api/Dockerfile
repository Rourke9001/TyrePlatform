# Build and runtime are separate stages: the runtime image carries only a
# static binary — no shell, no libc, no package manager. There is nothing to
# exploit or patch in the final layer.
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
# CGO off makes the binary fully static so it runs on distroless/static.
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/api ./cmd/api

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/api /api
# Container Apps ingress targets 8080 (infra/main.bicep); main.go defaults to
# the same, so this is documentation more than configuration.
ENV PORT=8080
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/api"]
