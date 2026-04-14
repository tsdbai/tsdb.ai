# Chat Integrations (Pro)

Chat Integrations lets you connect TSDB.ai to your team's messaging platforms. Configure webhooks for Slack, Microsoft Teams, Webex, and Telegram in one screen, choose which event types trigger notifications, and verify delivery instantly with a one-click test.

## Supported Platforms

| Platform | Configuration |
|---|---|
| Slack | Incoming Webhook URL |
| Microsoft Teams | Workflow / Connector Webhook URL |
| Cisco Webex | Bot token + Room ID |
| Telegram | Bot token + Chat ID |

## Event Types

Each platform can be independently subscribed to any combination of event types:

- **Anomalies** — when the anomaly detector fires on a metric
- **Alerts** — when an Alert Builder rule triggers
- **Regime changes** — when a metric's baseline permanently shifts
- **Forecasts** — when a forecast-breach alert fires

## Message Format

Notifications include:
- Metric name and current value
- Event type and severity
- Timestamp
- Link back to the admin panel for that metric

## Rate Limiting

Each channel has a configurable rate limit to prevent alert fatigue during incident storms. When a channel is rate-limited, TSDB.ai batches multiple alerts into a single digest message.

## One-Click Test

After configuring a webhook, use the **Test** button to send a sample notification immediately. This verifies the webhook URL is valid and reachable before you commit to using it in production.

## Access

Chat Integrations is a **Pro** feature. Visit [tsdb.ai/pro](https://tsdb.ai/pro) to upgrade.
