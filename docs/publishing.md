# Publishing

## CI concurrency (issue 162)

- Pull-request runs share `ci-pr-<number>`; a newer commit cancels the older
  in-progress run.
- Main pushes use `ci-main` and releases use `release-<ref>`; neither is
  cancelled by PR activity.
- The aggregate `required` check still fails closed if any mandatory job is
  cancelled or does not succeed.

## Release

- Tag a release: `git tag v0.1.0 && git push --tags`
- GitHub Actions (`.github/workflows/release.yml`) builds and pushes:
  - toolchain-only Docker image (no MCP server) to
    `ghcr.io/<owner>/android-mcp:v0.1.0` and `:latest`
  - npm package `@<scope>/android-mcp` to the registry (requires `NPM_TOKEN` secret)
- Until a release tag is pushed, no image is published, so users must build
  locally with `docker build -t open-droid-toolchain:0.1.0 .` (see README /
  quickstart). To mirror the same image to Docker Hub:
  `docker tag open-droid-toolchain:0.1.0 neetigyamaurya2/open-droid:<tag> &&
  docker push neetigyamaurya2/open-droid:<tag>`.
