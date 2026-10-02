# Signal Loom

Signal Loom is a local-first SOC triage MVP. It accepts normalized security alerts as JSON or CSV, stores them locally, correlates alerts that share entities in a time window, and ranks the resulting attack stories with visible risk factors.

## Run locally

Requires Node.js 20.19+ or 22.12+.

```sh
npm install
npm run dev
```

Open `http://localhost:5173`. The `dev` command starts both Vite and the API. Vite proxies `/api` requests to `http://127.0.0.1:3001`.

```sh
npm test
npm run build
```

For a single-process production preview, run `npm run build` followed by `npm start`; the API serves the built UI at `http://127.0.0.1:3001`.

## Import alerts

Use **Import alerts** in the dashboard for `.json` or `.csv` files. Ready-to-import examples are in `samples/`.

JSON accepts one record, an array, or an `{ "alerts": [...] }` envelope:

```json
{
  "alerts": [
    {
      "source": "Example EDR",
      "sourceEventId": "event-123",
      "timestamp": "2026-10-02T10:00:00Z",
      "severity": "High",
      "title": "Unusual process blocked",
      "description": "A process was blocked on a managed endpoint.",
      "entities": ["user:alex@example.test", "host:workstation-12"],
      "technique": "T1059"
    }
  ]
}
```

Required fields are `source`, `severity`, `title`, and at least one `entities` value. `timestamp` defaults to the current time. Severities are `Critical`, `High`, `Medium`, and `Low`; common values such as `sev1`, `P2`, and `informational` are normalized. Entity strings should be consistently typed, for example `user:...`, `host:...`, `ip:...`, or `resource:...`.

CSV requires a header row. Common source, event ID, time, priority, title, description, entity, and MITRE-technique column aliases are recognized. Put multiple entities in one cell separated by semicolons or pipes. Imports are limited to 5,000 records and 2 MB per request. Repeated vendor event IDs are deduplicated by source.

## API

- `GET /api/health` returns API status and stored alert count.
- `GET /api/stats` returns alert, story, priority, and source counts.
- `GET /api/alerts?limit=100` returns recent normalized alerts.
- `GET /api/stories` recomputes the ranked story list and its evidence.
- `POST /api/alerts` accepts JSON or CSV alert imports.
- `PATCH /api/stories/:id/status` accepts `{ "status": "Contained" }` (also `Open` or `Investigating`).
- `POST /api/stories/:id/case` records a local case-created timestamp.
- `POST /api/demo/reset` replaces the local store with demo alerts.

## Correlation and ranking

Alerts are joined when they share a normalized entity and occur within 60 minutes. Connected links are transitive. Each alert is indexed once per entity, so grouping is approximately linear in the number of alert/entity pairs. A story's risk score adds severity points, repeated-evidence points, distinct-source points, a sensitive-entity bonus, and a recent-activity bonus; the UI shows each nonzero factor. Correlation confidence is a separate heuristic based on evidence count and source diversity, not a calibrated probability.

## Local data and security

The API binds to `127.0.0.1` by default. The JSON store is created at `data/store.json` and is ignored by Git. It contains normalized alert fields and local response state; it is not encrypted. The API has no authentication, tenant isolation, or production authorization layer. Do not expose it to a network or import credentials, tokens, or unnecessary raw event payloads.

Vendor-specific live connectors are not included. Export or map tool alerts to the normalized schema and send them to the ingest endpoint; production deployment requires authenticated connectors, access control, encrypted storage, retention policy, and operational monitoring.