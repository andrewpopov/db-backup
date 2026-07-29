---
kind: security
summary: never log a webhook URL — a failed notify POST printed the full webhook in plaintext
---

`notifyAlert` kept the alert *body* off the command line (`curl -d @-`) but the
webhook URL was still an argv element, and `execFileSync` puts the whole command
line into `error.message`. So whenever a notify POST failed, the catch block
`console.warn`'d the complete webhook URL — into stdout, and from there into
journald or any log collector. This happened in practice: a DNS failure on a
6-hourly freshness monitor wrote a live Discord `#alerts` webhook to the host
journal in plaintext, where it stayed.

Anything derived from a notify error is now passed through `redactWebhookUrl`
(exported for consumers), which strips a known URL by exact match plus any
`/webhooks/…` or `discord(app).com/api/webhooks/…` URL, while preserving the rest
of the diagnostic. Applies to `--notify-discord`, `--notify-webhook`, and
`--notify-command` (an operator-supplied command may embed a URL too).

**Operator action:** a webhook that appeared in logs before this release should be
treated as disclosed and rotated.
