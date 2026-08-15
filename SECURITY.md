# Security Policy

## Supported Versions

This package reached `1.0.0` — see [`docs/versioning-policy.md`](./docs/versioning-policy.md)
for what that commits to. Only the latest published minor version of the
current major receives security fixes.

| Version            | Supported          |
| ------------------ | ------------------ |
| 1.x (latest minor) | :white_check_mark: |
| 1.x (older minor)  | :x:                |
| < 1.0              | :x:                |

If/when a `2.0.0` ships, this table (and whether the final `1.x` minor gets
a bounded backport window) will be updated at that time.

## Reporting a Vulnerability

**Please do not open a public issue for security reports.**

Report vulnerabilities privately using GitHub's Security Advisories flow:

- Go to the **Security** tab of this repository -> **Report a vulnerability**, or
- Use this link directly: https://github.com/NovaVey/Multi-Tenant-Security-Kit/security/advisories/new

Include as much detail as you can: affected version(s), the module involved
(e.g. `tenant`, `rbac`, `rate-limit`, `audit`, `rls`, `crypto`), reproduction
steps, and the potential impact.

If GitHub Security Advisories is not reachable for you, you may instead
contact **novavey.ai@gmail.com** as a secondary channel.

### What to expect

- We aim to acknowledge new reports within **3 business days**.
- We will work with you to understand and confirm the issue, develop a fix,
  and coordinate a disclosure timeline before any public details are
  published.
- Fixes are released as part of coordinated disclosure. Reporters are
  credited in the release notes unless they prefer to remain anonymous.
