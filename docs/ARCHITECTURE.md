# Architecture

The server is intentionally small: one tool, three external APIs, two transports. This document explains the shape and the reasoning behind each file.

## Request flow

```
MCP client (Claude / Inspector)
  │
  │ stdio JSON-RPC frame  (or POST /mcp)
  ▼
src/index.ts  ────or───  src/http.ts
  │                           │
  └──────► createServer() ◄───┘
             │
             │ registers get_building_profile
             ▼
       tool handler (src/tools/get-building-profile.ts)
             │
             ├──► BagClient.findAddress   (PDOK Locatieserver — open)
             ├──► BagClient.getVerblijfsobject  (BAG OGC v2 — open)
             ├──► BagClient.getPand        (BAG OGC v2 — open)
             └──► EpOnlineClient.getByBagVboId  (EP-Online V5 — API key)
             │
             ▼
       selectBestLabel() → PandEnergielabelV5 | null
             │
             ▼
       buildProfile() → BuildingProfile  (pure mapping)
             │
             ▼
       generateAlerts() → alerts[]
             │
             ▼
       structuredContent
```

VBO and EP-Online are fetched in parallel once the VBO ID is known; the pand fetch chains off the VBO response because it needs the `pand.href` relation link.

## Layers

### Transport (`src/index.ts`, `src/http.ts`)

Thin entrypoints that set up a transport and call `createServer()`. They own nothing else.

- **stdio** is the default. Every local MCP client speaks it. No network, no ports, no auth concerns.
- **streamable-HTTP** is optional, stateless, JSON-mode. Bound to `127.0.0.1` with no authentication — this is a **local convenience**, not a production pattern. Put an auth proxy in front if you need to expose it.

### Server factory (`src/server.ts`)

Single source of truth for tool registration. Accepts optional injected clients (narrowed to the `BagClientLike` / `EpOnlineClientLike` `Pick<>` types exported by the tool module) for tests; in production it constructs its own. Sets the server `instructions` string that agents see when they connect.

### Tool (`src/tools/get-building-profile.ts`)

- `description` — the prose the agent reads. Structured into `RETURNS`, `WHEN TO USE`, `WHEN NOT TO USE`, `QUERY STRATEGY`, `INTERPRETATION`, `ALERTS`. Every one of those sections earns its place — Dutch energy labels have genuine unit quirks between NTA 8800 / NEN 7120 / Nader Voorschrift, and without that context agents will miscompare values across calculation methods.
- `inputSchema` — Zod with `.describe()` on every field. The MCP SDK turns these into JSON Schema for the client.
- `outputSchema` — same treatment. Agents see the per-field docs when deciding which fields to surface. The profile TypeScript type is `z.infer<typeof outputSchema>`, so there's one definition of the shape across the codebase.
- Handler — fetch in parallel, map the upstream records via `buildProfile()`, generate alerts, return `structuredContent` + a textual fallback. The textual fallback matters: clients that don't yet consume `structuredContent` still need a readable reply.

### Clients (`src/clients/`)

One class per upstream system. Each class owns its URL, its auth, its timeout (`timeoutMs` option on the constructor), and its **Zod-validated response parsing**. If PDOK or EP-Online drift their wire format, the failure surfaces here with field-level schema errors rather than silently producing malformed output downstream. No retry logic — upstream failure bubbles up to the tool handler, which returns an `isError` response. Keep it honest.

`BagClient` is authentication-free. `EpOnlineClient` requires an API key in the `Authorization` header; the constructor fails fast with a pointer to `.env.example` if the key is missing.

`BagClient.findAddress` also post-filters Locatieserver results against the requested huisletter/toevoeging — PDOK's `/free` endpoint ranks by relevance and may otherwise return close-but-not-equal matches when the precise address isn't found.

### Domain (`src/domain/`)

Pure functions. Three of them:

- `buildProfile` — maps (address, vbo, pand, label) → `BuildingProfile`. One copy, shared by the tool handler (for both the happy and `not_found` branches via `emptyProfile()`) and the live smoke script.
- `selectBestLabel` — if a VBO has multiple labels, prefer still-valid ones, then break ties on `Opnamedatum`.
- `generateAlerts` — the interesting one. Encodes knowledge that belongs with the tool: Dutch building-regulation eras (pre-1992, pre-2003, pre-2015), Paris Proof 2040 thresholds per function (70 kWh/m² office, 100 kWh/m² residential), BENG compliance summaries, Nader Voorschrift unit quirks (where `co2_emissie` is a total, not per m²), warmtepomp-geschiktheidsindicatie.

The agent could in principle derive all of this from the raw fields — but we know it sometimes doesn't, so we do it once, server-side, and hand the agent a flat array of Dutch strings it can pass through to the user. Move knowledge to where the data lives.

### Logger (`src/logger.ts`)

Stderr-only structured JSON. No third-party dependency. **Never** writes to stdout — stdio MCP framing uses stdout, and a stray `console.log` would corrupt the JSON-RPC stream.

## Non-goals

- **Authentication.** Out of scope. Add a proxy.
- **Telemetry.** Out of scope. Hook into `logger.ts` if you want it.
- **Persistence.** The tool is idempotent and stateless — there's nothing to persist.
- **Mocking framework.** Test stubs are hand-rolled object literals typed against the `BagClientLike` / `EpOnlineClientLike` `Pick<>` types.

## External API reference

| API                | URL                                                                    | Auth          | Rate-limit |
| ------------------ | ---------------------------------------------------------------------- | ------------- | ---------- |
| PDOK Locatieserver | `https://api.pdok.nl/bzk/locatieserver/search/v3_1/free`               | none          | generous   |
| BAG OGC v2         | `https://api.pdok.nl/kadaster/bag/ogc/v2`                              | none          | generous   |
| EP-Online V5       | `https://public.ep-online.nl/api/v5/PandEnergielabel/AdresseerbaarObject/{vboId}` | API key in `Authorization` | per-key    |
