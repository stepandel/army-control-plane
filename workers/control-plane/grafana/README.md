# Grafana Cloud — dashboards & alert rules

Versioned exports of the Grafana Cloud dashboards and alert rules that provide the visualization + threshold-alert layer for the tenant Fly fleet. They complement the binary state alerts fired by `workers/control-plane/src/lib/health-check.ts`.

## Contents

| File | Purpose |
|------|---------|
| `fleet-overview.json` | Fleet-wide CPU, memory, disk, concurrency, tenant count, alert history |
| `tenant-detail.json` | Single-tenant drilldown — templated by the `$app` variable (one Fly app = one tenant) |
| `deployments.json` | Per-tenant deploy activity — `fly_instance_up`, recent state transitions |
| `alerts/oom-pressure.yaml` | `fly_instance_memory_mem_available_percent < 10` for 5m → critical |
| `alerts/memory-spike.yaml` | `fly_instance_memory_mem_used_percent > 90` for 10m → warning |
| `alerts/volume-nearing-cap.yaml` | `fly_volume_used_percent > 85` for 10m → warning |

All queries target the **Fly managed Prometheus** endpoint (`https://api.fly.io/prometheus/vera-ai`) — see `docs/monitoring.md` for data-source setup.

## Expected data-source UID

All dashboard panels reference `datasource.uid = "fly-prometheus"`. When adding the Fly Prometheus data source in the Grafana UI, set the UID to exactly `fly-prometheus` (Grafana → Connections → Data sources → Add → Prometheus → Settings → UID). Otherwise the imported dashboards will show empty panels until you re-point each datasource by hand.

Same for alert rules — the `datasourceUid` field in every `alerts/*.yaml` must match.

## Editing guidance

Dashboards are **versioned JSON** — after making changes in the Grafana UI, export via *Dashboard settings → JSON Model → Save JSON to file* and replace the file here. Don't hand-edit unless you know Grafana's panel schema.

Alert rules **can** be hand-edited — they're simpler and the provisioning format is documented at <https://grafana.com/docs/grafana/latest/alerting/set-up/provision-alerting-resources/file-provisioning/>.

## Notes on Fly metric names

Fly ships built-in metrics in the following families (confirmed at <https://fly.io/docs/monitoring/metrics/#built-in-metrics>):

- `fly_instance_cpu_*` — per-core usage counters in nanoseconds (use `rate()` over a window)
- `fly_instance_memory_mem_used_percent` / `mem_available_percent` / `mem_used_bytes` / `mem_total_bytes`
- `fly_instance_filefd_*` — open fd counts
- `fly_volume_used_percent` / `fly_volume_size_bytes`
- `fly_app_concurrency_*` — concurrent request counts for each service port
- `fly_instance_up` — 1 when the machine is reporting, 0 when scraping fails

Custom metrics from `/metrics` on port 3000 (exposed by the tenant app) pass through automatically under their own names. Use `{app=~"army-t.*"}` to scope any query to tenant apps and exclude control-plane / builder apps.
