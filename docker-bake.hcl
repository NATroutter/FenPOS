# How the two images are built.
#
# Kept here rather than in the workflow so the same definition serves CI and a laptop:
# `docker buildx bake` builds both, `docker buildx bake server` builds one. A build that only
# exists as a series of action inputs cannot be reproduced locally without transcribing it.
#
# CI overrides platform, output and cache per run, because those are properties of where a
# build happens rather than of what is being built.

variable "REGISTRY" {
  default = "ghcr.io"
}

variable "OWNER" {
  default = "natroutter"
}

# Filled in by docker/metadata-action, which writes a bake file defining this target with the
# tags, labels and annotations it worked out. Empty here so a local build still works.
target "docker-metadata-action" {}

target "_common" {
  inherits   = ["docker-metadata-action"]
  dockerfile = "Dockerfile"

  # Only what a local build should default to. CI narrows this to one platform per runner and
  # merges the results afterwards, so nothing here is emulated.
  platforms = ["linux/amd64", "linux/arm64"]
}

target "server" {
  inherits = ["_common"]
  context  = "fenpos"
  tags     = ["${REGISTRY}/${OWNER}/fenpos:local"]
}

target "agent" {
  inherits = ["_common"]
  context  = "agent"
  tags     = ["${REGISTRY}/${OWNER}/fenpos-agent:local"]
}

group "default" {
  targets = ["server", "agent"]
}
