# Outgoing Webhooks

Point NutriTrace at a URL and it fires a signed HTTP POST the instant
something happens: a food is logged, water is logged, a body stat is
logged, or a daily nutrition goal is reached. The push counterpart to
the [general public API](public-api.md), for wiring NutriTrace into
n8n, Home Assistant, or any other automation without polling. Off by
default.

## Enabling it

```
WEBHOOKS_ENABLED=1
```

Optionally, to allow a webhook target on a private or loopback address
(a same-Docker-network Home Assistant instance, for example):

```
ALLOW_PRIVATE_WEBHOOK_URLS=1
```

## Configuring a webhook

Settings, Webhooks (admin, multi-user mode only, a webhook needs a real
account to own it). Provide a target URL and pick which events to
subscribe to. A secret is generated automatically (or you can supply
your own), shown exactly once, save it, it is needed to verify
signatures on the receiving end and cannot be retrieved again later.

## Events

| Event | Fires when |
|---|---|
| `meal.logged` | A food item is added to a diary day. |
| `water.logged` | A water entry is added to a diary day. |
| `body_stat.logged` | A body-stat value (weight, body fat, a measurement) is logged or updated. |
| `goal.achieved` | A daily nutrition goal (calories, a macro, or water) crosses from under-target to at-or-above-target on a save. Fires once per metric per crossing, not on every subsequent save that stays above target. |

## Payload

Every delivery is a JSON POST with this envelope:

```json
{
  "event": "meal.logged",
  "timestamp": "2026-09-12T14:30:00.000Z",
  "data": { ... event-specific ... }
}
```

`data` for `goal.achieved` looks like:

```json
{
  "date": "2026-09-12",
  "metric": "protein",
  "target": 150,
  "actual": 152
}
```

## Verifying a delivery

Each request carries:

```
X-NutriTrace-Signature: sha256=<hex hmac-sha256 of the exact raw request body, using your webhook's secret>
X-NutriTrace-Event: meal.logged
X-NutriTrace-Delivery: <a uuid unique to this specific delivery attempt>
```

Recompute the HMAC over the raw body bytes you received (not a
re-serialized copy) and compare it to the signature header. Example in
Node:

```js
import { createHmac, timingSafeEqual } from 'crypto';

function verify(rawBody, signatureHeader, secret) {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const given = signatureHeader.replace('sha256=', '');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}
```

## Retries and delivery status

A failed delivery (a network error, a timeout, or a non-2xx response)
is retried up to 3 times total, with a short backoff. There is no
persistent delivery queue: if a receiver is down for longer than a few
seconds, that event is not redelivered later. This is a deliberate
tradeoff for a self-hosted, personal-scale feature rather than a full
delivery queue with hours of retry.

Each webhook's last delivery outcome (delivered or failed, with the
error) is shown in Settings, use the "send test event" button there to
verify a target works without waiting for a real event.
