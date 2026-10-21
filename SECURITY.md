# Security Policy

xkg holds credentials on your behalf — a GitHub OAuth token, your LLM API key, and
an MCP key — so security reports are welcome and taken seriously.

## Reporting a vulnerability

**Please do not open a public issue.** Report privately through
[GitHub Security Advisories](https://github.com/xmu-labs/xkg/security/advisories/new),
which keeps the details unpublished until a fix ships.

Useful things to include: what an attacker can do, the steps to reproduce it, and which
version or commit you tested. A proof of concept helps but is not required.

This is a small project maintained by one person, so response times are best-effort rather
than contractual.

## Scope

**In scope** — the hosted instance at
[mnemos-capture.vercel.app](https://mnemos-capture.vercel.app) and this repository:
authentication and session handling, the OAuth 2.1 flow used by MCP connectors, credential
storage, the MCP tool surface, and server-side request handling.

**Out of scope**

- **Self-hosted deployments.** Running your own copy is permitted by the MIT license but
  unsupported — see [CONTRIBUTING.md](CONTRIBUTING.md#self-hosting). A self-hosted instance
  does not receive fixes made here.
- Your own knowledge repository. It lives in your GitHub account under your control;
  its visibility and access are yours to manage.
- Findings that require an already-compromised GitHub account or a compromised device.
- Vulnerabilities in GitHub, Vercel, or your chosen LLM provider — report those upstream.

## What xkg already does

Documented in the README under
[What xkg stores, and where](README.md#what-xkg-stores-and-where): captures are never
stored server-side, GitHub and LLM credentials are encrypted at rest, the MCP key is stored
hashed, PINs use salted scrypt, PIN unlock is bound to a device that has completed GitHub
sign-in, and server-side URL fetching is guarded against SSRF across redirects.

None of that means there is nothing left to find. If you find something, please tell us.
