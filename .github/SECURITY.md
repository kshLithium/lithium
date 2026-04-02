# Security

Lithium is a local-first CLI that can call external models, edit real files, and run shell tasks inside the selected workspace. Treat it like a powerful local developer tool, not a sandbox.

## Reporting A Vulnerability

Please do not open a public issue for a suspected security vulnerability.

When this repository is public, use GitHub private vulnerability reporting / Security Advisories first.

If private reporting is not available yet, contact the maintainer through the fallback channel listed in the repository profile and include:

- a short description of the issue
- the affected file or feature
- reproduction steps
- impact and any suggested mitigation

If the issue involves exposed credentials, rotate those credentials first.

## Public Repository Checklist

Before making the repository public:

1. Remove any committed secrets from the current tree and the full Git history.
2. Rotate any API keys that may have been used during development.
3. Keep real secrets in environment variables, not in tracked files.
4. Keep `.lithium/`, local logs, and test artifacts out of Git.
5. Review sample workspaces and shared transcripts for personal paths or private data.
6. Enable GitHub secret scanning and push protection where available.

## Current Project Practices

The repo is set up so that:

- `.env` files are ignored
- `.lithium/` is ignored
- local build output and test artifacts are ignored
- attachments are copied into the active workspace, not hidden in a separate app data bundle
- settings are stored in `~/.lithium/settings.json`
- the CLI asks for an explicit Chrome sign-in flow before reusing a strategist session

## Things This Project Does Not Protect You From

- unsafe shell commands produced by the automation loop
- malicious code inside a workspace you choose to open
- sensitive data you attach to a thread on purpose
- secrets already present in your Git history

## Operational Guidance

- use a separate API key for this tool
- prefer environment variables over checked-in config files
- do not attach private credentials, SSH keys, or database dumps
- review the selected workspace before letting automation run unattended
- if you ever leak a secret, rotate it and then rewrite history before opening the repo
