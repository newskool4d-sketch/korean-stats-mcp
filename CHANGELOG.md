# Changelog

## 1.8.6 - 2026-08-10

### Security

- Deny HTTP startup when bearer authentication is not configured, unless the explicit local-development override is enabled.
- Reject JSON-RPC batch requests so rate accounting cannot be bypassed through one HTTP request.
- Bound KOSIS JSON rows and bytes, XLSX download bytes, and `compare_statistics` request arrays.
- Escape installer inputs across the shell-to-Python boundary and restrict custom endpoints to HTTPS or loopback HTTP.
- Pin the installer bridge to `mcp-remote@0.1.38` and verify tagged installer downloads with SHA-256.
- Remove the revoked KOSIS credential from tracked documentation.

### Fixed

- Include all response-affecting fields in `compare_statistics` cache keys.
- Evict the least-recently-used entry when the cache reaches its configured key limit.

### Dependencies

- Update `@modelcontextprotocol/sdk` to `^1.30.0` and `kordoc` to `^4.7.2`.
- Add targeted transitive overrides so the production dependency audit is clean.
