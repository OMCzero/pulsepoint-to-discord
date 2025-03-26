export { PulsePointWorkflow } from './pulsepoint-workflow';

// Define environment binding types
interface Env {
  PULSEPOINT_WORKFLOW: Workflow;
  PULSEPOINT_KV: KVNamespace;
  DISCORD_WEBHOOK_URL: string;
  DISCORD_STANDBY_WEBHOOK_URL: string;
}

export default {
  // This runs on the configured cron schedule (every minute)
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Create a new Workflow instance when triggered by the schedule
    const instance = await env.PULSEPOINT_WORKFLOW.create();
    console.log(`Started PulsePoint workflow: ${instance.id}`);
  },

  // This allows manual triggering and status checks via HTTP
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    
    // Check status of an existing workflow instance
    const instanceId = url.searchParams.get('instanceId');
    if (instanceId) {
      try {
        const instance = await env.PULSEPOINT_WORKFLOW.get(instanceId);
        return Response.json({
          id: instance.id,
          status: await instance.status()
        });
      } catch (error) {
        return Response.json({ error: `Instance not found: ${instanceId}` }, { status: 404 });
      }
    }

    // Manually trigger workflow
    if (url.pathname === '/trigger') {
      const instance = await env.PULSEPOINT_WORKFLOW.create();
      return Response.json({
        id: instance.id,
        message: 'Workflow instance created',
        status: await instance.status()
      });
    }

    // Get the latest stored incident ID
    if (url.pathname === '/latest-id') {
      const latestId = await env.PULSEPOINT_KV.get('latestIncidentId');
      return Response.json({
        latestIncidentId: latestId || '0'
      });
    }

    // Reset the latest incident ID (useful for testing)
    if (url.pathname === '/reset-id' && request.method === 'POST') {
      const body = await request.json<{ id?: string }>();
      const newId = body.id || '0';
      await env.PULSEPOINT_KV.put('latestIncidentId', newId);
      return Response.json({
        message: `Latest incident ID reset to ${newId}`
      });
    }

    // Default response with usage instructions
    return new Response(
      `
      <html>
        <body>
          <h1>PulsePoint to Discord Workflow</h1>
          <p>Available endpoints:</p>
          <ul>
            <li><a href="/trigger">POST /trigger</a> - Manually trigger the workflow</li>
            <li><a href="/latest-id">GET /latest-id</a> - Get the latest incident ID that was processed</li>
            <li>POST /reset-id - Reset the latest incident ID (send JSON with "id" field)</li>
            <li>GET /?instanceId=xxx - Check the status of a workflow instance</li>
          </ul>
        </body>
      </html>
      `,
      {
        headers: {
          'Content-Type': 'text/html; charset=UTF-8'
        }
      }
    );
  }
};