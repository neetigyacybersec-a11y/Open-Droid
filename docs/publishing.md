# Publishing

- Tag a release: `git tag v0.1.0 && git push --tags`
- GitHub Actions (`.github/workflows/release.yml`) builds and pushes:
  - Docker image to `ghcr.io/<owner>/android-mcp:v0.1.0` and `:latest`
  - npm package `@<scope>/android-mcp` to the registry (requires `NPM_TOKEN` secret)
- Until a release tag is pushed, no image is published, so users must build
  locally with `docker build -t open-droid:latest .` (see README / quickstart).
