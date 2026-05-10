import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  PulsePointWorkflow,
  decryptPulsePointData,
  mapDispatchStatus,
  mapIncidentCallType,
} from './pulsepoint-workflow';

export { PulsePointWorkflow };

interface Env {
  PULSEPOINT_WORKFLOW: Workflow;
  PULSEPOINT_KV: KVNamespace;
  PULSEPOINT_DB: D1Database;
  DISCORD_WEBHOOK_URL: string;
  DISCORD_STANDBY_WEBHOOK_URL: string;
}

interface GeoJSONFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: Record<string, unknown>;
}

interface GeoJSONFeatureCollection {
  type: 'FeatureCollection';
  features: GeoJSONFeature[];
}

interface RawIncident {
  ID: string;
  AgencyID?: string;
  Latitude?: string;
  Longitude?: string;
  PulsePointIncidentCallType?: string;
  CallReceivedDateTime?: string;
  FullDisplayAddress?: string;
  MedicalEmergencyDisplayAddress?: string;
  Unit?: Array<{
    UnitID: string;
    PulsePointDispatchStatus: string;
    UnitClearedDateTime?: string;
  }>;
}

function incidentToFeature(incident: RawIncident, closed: boolean): GeoJSONFeature | null {
  const lat = parseFloat(incident.Latitude ?? '');
  const lon = parseFloat(incident.Longitude ?? '');
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const units = (incident.Unit ?? []).map((u) => ({
    unitId: u.UnitID,
    status: mapDispatchStatus(u.PulsePointDispatchStatus),
    rawStatus: u.PulsePointDispatchStatus,
    clearedAt: u.UnitClearedDateTime,
  }));

  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: {
      id: incident.ID,
      agencyId: incident.AgencyID,
      callType: mapIncidentCallType(incident.PulsePointIncidentCallType),
      rawCallType: incident.PulsePointIncidentCallType,
      address: incident.FullDisplayAddress,
      callReceived: incident.CallReceivedDateTime,
      closed,
      units,
      pulsepointUrl: `https://web.pulsepoint.org/?agencies=${incident.AgencyID ?? 'EMS1201'}&incident=${incident.ID}`,
    },
  };
}

export default class PulsePointService extends WorkerEntrypoint<Env> {
  async scheduled(controller: ScheduledController): Promise<void> {
    const instance = await this.env.PULSEPOINT_WORKFLOW.create();
    console.log(`Started PulsePoint workflow: ${instance.id}`);
  }

  // RPC method — callable from another Worker via a service binding:
  //   const geo = await env.PULSEPOINT.getIncidentsGeoJSON();
  async getIncidentsGeoJSON(): Promise<GeoJSONFeatureCollection> {
    const upstream = await fetch(
      'https://api.pulsepoint.org/v1/webapp?resource=incidents&agencyid=EMS1201'
    );
    if (!upstream.ok) {
      throw new Error(`PulsePoint upstream error: ${upstream.status}`);
    }

    const decrypted = await decryptPulsePointData(await upstream.json());
    const active: RawIncident[] = decrypted.incidents?.active ?? [];
    const recent: RawIncident[] = decrypted.incidents?.recent ?? [];

    const features = [
      ...active.map((i) => incidentToFeature(i, false)),
      ...recent.map((i) => incidentToFeature(i, true)),
    ].filter((f): f is GeoJSONFeature => f !== null);

    return { type: 'FeatureCollection', features };
  }
}
