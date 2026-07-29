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

Two different fixes, because the two cases have different information available:

- **`--notify-discord` / `--notify-webhook`** — the URL is known, so anything derived
  from a delivery error now passes through `redactWebhookUrl`, which exact-matches
  that URL (shape-independent, and safe against regex metacharacters) plus any
  `/webhooks/…` or `discord(app).com/api/webhooks/…` URL, preserving the rest of the
  diagnostic.
- **`--notify-command`** — the URL is *not* known: the command is operator-supplied
  and may embed a webhook of any vendor shape (Slack `hooks.slack.com/services/…`,
  Google Chat `?key=…&token=…`, Teams `…webhook.office.com/…`) or a credential that
  is not a webhook at all. Pattern-matching arbitrary operator input is unwinnable,
  so this sink now logs **nothing** derived from the error — only that it failed and
  the exit status.

`redactWebhookUrl` is exported, and now also **declared** in `index.d.ts` and
exercised by `scripts/types-consumer.ts` — so TypeScript consumers can actually
import it, and `verify:types` fails if the declaration is ever dropped again.

Deliberate limitation, asserted by a test rather than left as a surprise: with no
URL passed, `redactWebhookUrl` recognises only Discord-shaped URLs. Pass the URL
whenever you have it — that is the shape-independent path.

**Operator action:** a webhook that appeared in logs before this release should be
treated as disclosed and rotated.
