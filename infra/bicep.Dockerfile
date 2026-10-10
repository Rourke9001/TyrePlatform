# Bicep CLI for make infra-lint (TYRE-79). Microsoft publishes no Bicep-only
# image. The self-contained binary needs libssl, which runtime-deps carries
# and plain debian-slim does not.
FROM mcr.microsoft.com/dotnet/runtime-deps:8.0.30-bookworm-slim@sha256:c2fea32c9809b2041fef98c4df5367643662e15f81f7a081f7296e5927390215
# Renovate cannot see this ADD, so the Bicep version is bumped by hand,
# together with the Makefile's BICEP_IMAGE tag and deploy.yml's az bicep
# install (TYRE-304).
ADD --checksum=sha256:64c345a58e0c3e48b1bc98a4e62d6b3adb1d238281297de3400aeafb2697aa5a --chmod=755 \
    https://github.com/Azure/bicep/releases/download/v0.47.16/bicep-linux-x64 /usr/local/bin/bicep
WORKDIR /src
ENTRYPOINT ["bicep"]
