---
kind: changed
summary: backup attempts every destination, refuses to prune an ambiguous remote listing, and can alert on failure
---

`backup` now tries every destination before failing, so an S3 outage no longer blocks the Drime upload; any failed upload still skips retention and the success stamp, and the error keeps every `destinationResults` entry. Remote pruning (Drime and rclone) refuses a listing where one path appears twice or as both a file and a directory, and records `pruneFailed.reason`. `backup` accepts `--notify-discord`, `--notify-webhook` and `--notify-command` and sends one alert when the job fails and a distinct one when the backup succeeded but retention failed (exit code and stamp unchanged for the latter).
