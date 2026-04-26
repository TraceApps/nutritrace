---
name: Bug report
about: Something is broken or behaves unexpectedly
title: "[Bug] "
labels: bug
---

## Version
<!-- Settings → About → Version (e.g. v1.0.0-rc.1) -->

## Where
<!-- e.g. PWA in Chrome / NutriTrace Android app (Play Store) / sideload APK / server -->

## What I expected
<!-- A short description of what should happen -->

## What actually happened
<!-- A short description of what did happen, with screenshots if useful -->

## Steps to reproduce
1.
2.
3.

## Logs

<!--
Where to find logs:

Server (Docker):
  docker logs nutritrace --tail 200

PWA:
  F12 → Console tab. Filter by [wellness], [sync], [diary], etc.

Android app:
  Plug phone into USB → chrome://inspect/#devices in Chrome → "inspect" the
  WebView → Console tab → reproduce → copy/screenshot.

⚠️  REDACT before posting:
- HRV / RHR / sleep duration / weight / calorie counts (debug logs include these)
- Email addresses
- OAuth tokens (anything that looks like ya29.* or a long random string)
- Personal server URLs / IPs
-->

```
(paste logs here)
```
