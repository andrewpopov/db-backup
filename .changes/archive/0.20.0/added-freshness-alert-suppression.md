---
kind: added
summary: "freshness alert suppression: one alert per incident, with reminders and a recovery notice"
---

`freshness` notified on every invocation while a condition held, so a 6-hourly
timer against a stale backup posted the same message four times a day — ~25 a
week for one unchanged problem. It now runs the suppression state machine from
`@andrewpopov/alert-kit` and notifies only on a transition: `--fail-after-runs`
(default 1) before the first alert, `--recover-after-runs` (default 1) before a
`✅ backup is fresh again` notice, and `--realert-after-hours` (default 24) for
reminders while the problem persists (`0` disables reminders). State is persisted
to `--state-file`, which defaults to `<stamp-file>.alerts.json`; in `--remote`
mode there is no stamp file to derive one from, so pass it explicitly — without a
state file the old alert-every-run behaviour continues and a warning says so.

Suppression gates **notification only**. A stale backup still exits `1` on every
run, so any cron wrapper or monitor watching the exit status is unaffected. A
check that cannot run (missing `rclone`, unparseable listing) is treated as
`crit`, never as an indeterminate hold, because a checker that cannot check is
what this dead-man's switch exists to catch.
