# PulsePoint to Discord

A Cloudflare Worker that fetches emergency incident data from PulsePoint and posts it to Discord channels via webhooks.

## Overview

This project uses Cloudflare Workers and Cloudflare's Workflow API to:

1. Fetch incident data from PulsePoint's API on a scheduled basis
2. Decrypt and process the incident data
3. Filter incidents by location
4. Post new incidents to Discord via webhooks
5. Track and update existing incidents

Thanks to [Davnit](https://gist.github.com/Davnit/4a6e7dd94d97a05c3806b306e3d838c6) for the original logic for decrypting the PulsePoint data.

## Features

- **Scheduled Polling**: Automatically checks for new incidents every 2 minutes
- **Location Filtering**: Only processes incidents in specified locations (Vancouver, Burnaby, New Westminster, etc.)
- **Incident Type Handling**: Routes different types of incidents to different Discord channels
- **Persistent Storage**: Uses Cloudflare KV to track in-flight incidents across worker invocations
- **Historical Archive**: Records every observed incident in Cloudflare D1 (SQLite) with first/last-seen timestamps and final closed-at marker
- **GeoJSON RPC**: Exposes a worker-to-worker RPC method that returns active and recent incidents as a GeoJSON `FeatureCollection`

## Requirements

- Node.js (v16 or later)
- A Cloudflare account with Workers and KV enabled
- Discord webhook URLs

## Installation

1. Clone this repository
    ```bash
    git clone https://github.com/yourusername/pulsepoint-to-discord.git
    cd pulsepoint-to-discord
    ```

2. Install dependencies
    ```bash
    pnpm install
    ```

3. Set up your KV namespace in Cloudflare
    ```bash
    pnpm wrangler kv:namespace create PULSEPOINT_KV
    ```

4. Set up your D1 database for historical incident records
    ```bash
    pnpm wrangler d1 create pulsepoint-incidents
    ```
    Paste the returned `database_id` into `wrangler.toml`, then apply migrations:
    ```bash
    pnpm wrangler d1 migrations apply pulsepoint-incidents --local   # for dev
    pnpm wrangler d1 migrations apply pulsepoint-incidents --remote  # for prod
    ```

5. Update `wrangler.toml` with your KV namespace ID, D1 database ID, and Discord webhook URLs

## Development

Run the worker locally:
```bash
pnpm dev
```

## Deployment

Deploy to Cloudflare Workers:
```bash
pnpm deploy
```

## Service Binding (RPC)

The worker has no public HTTP endpoints. Instead, it exposes a typed RPC method consumable by another Worker via a service binding.

In the consuming Worker's `wrangler.toml`:

```toml
[[services]]
binding = "PULSEPOINT"
service = "pulsepoint-to-discord"
```

Then call it directly:

```ts
const geo = await env.PULSEPOINT.getIncidentsGeoJSON();
// → GeoJSON FeatureCollection of active + recent incidents
//   (each Feature has a Point geometry and incident properties; `closed: true` marks recent/closed incidents)
```

## Configuration

Configuration is managed through `wrangler.toml`:

- `name` - The name of your Cloudflare Worker
- `kv_namespaces` - KV namespace binding for storing incident data
- `vars` - Environment variables (Discord webhook URLs)
- `triggers` - Cron schedule for automated execution
- `observability.logs` - Logging configuration

## License

This project is licensed under the MIT License. 