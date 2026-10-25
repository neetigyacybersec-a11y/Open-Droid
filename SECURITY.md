# Security

- Never commit secrets; `.env` is gitignored.
- MCP server runs local shell commands; only run on trusted projects.
- Docker image should be run with least privilege; KVM access is required for emulator acceleration.
- Report vulnerabilities via GitHub Security Advisories.
