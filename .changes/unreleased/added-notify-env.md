---
kind: added
summary: --notify-discord-env and --notify-webhook-env read the webhook URL from an environment variable
---

`freshness` and `backup` accept `--notify-discord-env <VAR>` and `--notify-webhook-env <VAR>`, which read the URL from `process.env[VAR]` when an alert is sent, so it no longer shows in `ps` or a crontab. The name must match `^[A-Z_][A-Z0-9_]*$`, and giving a URL flag with its `-env` twin is a usage error. An unset or empty variable logs `notification skipped: <VAR> is not set` and leaves the verdict and exit code unchanged.
