# Agent Radar — Padova microzone filtering (sample payload)

**Endpoint AcquisitionRadar must call:**
`POST {SUPABASE_URL}/functions/v1/civiko-radar-veneto/agent-radar`

(aliases: also matched on `/agentRadar`). Do **not** call `/agent-radar`, `/radar`,
or `/agency-opportunities` for the Padova radar flow — they are unrelated.

## Headers

| Header              | Value                                              |
|---------------------|----------------------------------------------------|
| `Content-Type`      | `application/json`                                 |
| `x-source-app`      | `acquisitionradar`                                 |
| `x-internal-secret` | `AI_CORE_SECRET_ACQUISITIONRADAR`                  |
| `Authorization`     | `Bearer <SUPABASE_ANON_KEY>`                       |

## Sample body — Padova, Arcella + Portello

```json
{
  "provincia": "PD",
  "comune": "Padova",
  "microzones": ["Arcella", "Portello / Università"]
}
```

`microzones` accepts either canonical labels (e.g. `"Arcella"`) **or** the 20
canonical ids (e.g. `"portello_universita"`). Unknown values are dropped
silently — never faked.

## Behaviour

- Empty/omitted `microzones[]` → results are **annotated** only, nothing dropped.
- Non-empty `microzones[]` → results are **filtered**: only items matched to one
  of the selected microzone ids are returned. `unknown` and non-matching items
  are dropped (counts surfaced in `summary.microzoneMatchCounts`).
- Match is real or absent — `microzone_match: "unknown"` is preserved as-is.

## Per-item fields added

Every `zones[*]` and `opportunities[*]` now carries:

- `microzone` — canonical label or `null`
- `microzone_id` — canonical id or `null`
- `microzone_match` — `"matched" | "unknown"`
- `microzone_match_confidence` — `"high" | "medium" | "low" | "unknown"`
- `microzone_match_method` — `"label_explicit" | "indirizzo_keyword" | "omi_zone" | "text_keyword" | "none"`

Plus, at top level: `summary.microzonesSelected` and
`summary.microzoneMatchCounts` for diagnostics.

## Verify with curl

```bash
curl -sS -X POST "$SUPABASE_URL/functions/v1/civiko-radar-veneto/agent-radar" \
  -H "Content-Type: application/json" \
  -H "x-source-app: acquisitionradar" \
  -H "x-internal-secret: $AI_CORE_SECRET_ACQUISITIONRADAR" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -d '{"provincia":"PD","comune":"Padova","microzones":["Arcella","Portello / Università"]}' \
  | jq '.summary.microzonesSelected, .summary.microzoneMatchCounts,
        (.opportunities[0] | {microzone, microzone_id, microzone_match, microzone_match_confidence, microzone_match_method})'
```

## Verify with edge function logs

Search `civiko-radar-veneto` logs for `[agent-radar] microzones` — emits the
selected ids and per-id match counts on every call.
