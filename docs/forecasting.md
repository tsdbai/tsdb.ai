# Forecasting

The Forecasting engine projects future metric values forward from the current polynomial model state, with confidence bands derived from historical RMSE. It requires no configuration beyond the global ingestion settings.

## Responsibilities

- Extends the current polynomial model fit forward by a configurable horizon
- Computes upper and lower confidence bands using rolling RMSE history
- Serves forecast data via the Query Gateway's `/api/v1/forecast` endpoint
- Powers the **Forecast** page in the admin panel

## How It Works

Because every metric is already represented as a polynomial model (rather than raw samples), forecasting is a natural extension — the model is simply evaluated at future time points. The confidence band is derived from the series' historical RMSE, reflecting how much the actual data typically deviates from the model prediction.

```
Historical data   →   Polynomial model fit
                              │
                              ▼
                    Extrapolate forward N seconds
                              │
                              ▼
              Upper band = forecast + (rmse_history × confidence_floor)
              Lower band = forecast - (rmse_history × confidence_floor)
```

## Configuration Reference

| Setting | Default | Description |
|---|---|---|
| `default_horizon_s` | 300.0 | Default forecast window (5 minutes) |
| `confidence_floor` | 0.001 | Minimum band half-width for flat series |

```yaml
forecasting:
  default_horizon_s: 300.0
  confidence_floor: 0.001
```

## Query API

```http
GET /api/v1/forecast?metric=http_latency_p99&horizon=600
```

Returns synthesized data points with `value`, `upper`, and `lower` fields for each projected timestamp.

## Forecast-Breach Alerts (Pro)

The Alert Builder (Pro) allows you to define **forecast-breach** alert rules that fire when the forecasted value is projected to exceed a threshold within a given time horizon — before the breach actually happens. See [Alert Builder docs](./alert-builder.md).

## Notes

- Forecasting accuracy depends on how well the current polynomial model fits the metric's recent behavior. Highly erratic or step-change metrics will have wide confidence bands
- The `confidence_floor` prevents zero-width bands on perfectly flat series (e.g. a metric stuck at 0)
- Longer horizons produce lower accuracy — treat forecasts beyond 30 minutes as directional only
