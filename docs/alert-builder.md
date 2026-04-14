# Alert Builder (Pro)

The Alert Builder lets you define alert rules on any ingested metric and route notifications to Slack, Microsoft Teams, Webex, or Telegram. Rules can be based on fixed thresholds, statistical deviation, percentage change, or forecast-breach projections.

## Rule Types

| Type | Fires when... |
|---|---|
| **Threshold** | Metric value crosses a fixed upper or lower bound |
| **RMSE** | Model fit error exceeds N× the historical baseline |
| **% Change** | Value changes by more than N% within a time window |
| **Forecast Breach** | Forecast projects a threshold breach within the next N minutes |

## Forecast-Breach Alerts

The forecast-breach type is unique to TSDB.ai — it fires **before** the metric actually breaches the threshold, based on the forward projection. For example:

> "Fire a HIGH alert if `checkout_latency` is forecast to exceed 500ms within the next 60 minutes"

This gives your team lead time to act before users are impacted.

## Severity Levels

Alerts can be assigned a severity level, which controls notification formatting and filtering:

- LOW
- MEDIUM
- HIGH
- CRITICAL

## Delivery Channels

Alerts are delivered via the Chat Integrations webhooks (see [Chat Integrations](./chat-integrations.md)). Each rule can target one or more configured channels.

## Natural Language Preview

Before saving a rule, the Alert Builder renders a plain-English description of what will fire:

> "Fire CRITICAL alert if `error_rate` exceeds 5% → Slack #incidents"

## Configuration

Alert rules are stored in `{data.root}/registry/alerts.json`. Rules survive restarts.

## Access

Alert Builder is a **Pro** feature. Users on the free tier will see a feature gate screen at `/alerts`. Visit [tsdb.ai/pro](https://tsdb.ai/pro) to upgrade.
