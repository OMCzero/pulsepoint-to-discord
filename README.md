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
- **Persistent Storage**: Uses Cloudflare KV to track incidents across worker invocations
- **Manual Controls**: HTTP endpoints for triggering workflows and managing incident tracking

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
    npm install
    ```

3. Set up your KV namespace in Cloudflare
    ```bash
    npx wrangler kv:namespace create PULSEPOINT_KV
    ```

4. Update `wrangler.toml` with your KV namespace ID and Discord webhook URLs

## Development

Run the worker locally:
```bash
npm run dev
```

## Deployment

Deploy to Cloudflare Workers:
```bash
npm run deploy
```

## API Endpoints

The worker exposes the following HTTP endpoints:

- `GET /` - Shows usage instructions
- `POST /trigger` - Manually triggers the workflow
- `GET /latest-id` - Gets the latest incident ID that was processed
- `POST /reset-id` - Resets the latest incident ID (send JSON with "id" field)
- `GET /?instanceId=xxx` - Checks the status of a workflow instance

## Configuration

Configuration is managed through `wrangler.toml`:

- `name` - The name of your Cloudflare Worker
- `kv_namespaces` - KV namespace binding for storing incident data
- `vars` - Environment variables (Discord webhook URLs)
- `triggers` - Cron schedule for automated execution
- `observability.logs` - Logging configuration

## License

This project is licensed under the MIT License. 