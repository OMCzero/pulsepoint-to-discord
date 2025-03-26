import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

// Environment variables and bindings
type Env = {
  // KV namespace for storing incident data and tracking
  PULSEPOINT_KV: KVNamespace;
  // Discord webhook URLs
  DISCORD_WEBHOOK_URL: string;
  DISCORD_STANDBY_WEBHOOK_URL: string;
  // Workflow binding
  PULSEPOINT_WORKFLOW: Workflow;
};

// No special parameters needed for scheduled execution
type Params = Record<string, unknown>;

// Define types for PulsePoint data structures
interface PulsePointResponse {
  ct: string;  // Ciphertext (base64)
  iv: string;  // Initialization Vector (hex)
  s: string;   // Salt (hex)
}

interface PulsePointUnit {
  UnitID: string;
  PulsePointDispatchStatus: string;
  DisplayDispatchStatus?: string;
}

interface PulsePointIncident {
  ID: string;
  Closed?: boolean;
  CallReceivedDateTime?: string;
  PulsePointIncidentCallType?: string;
  DisplayIncidentCallType?: string;
  FullDisplayAddress?: string;
  Unit?: PulsePointUnit[];
}

// Define Discord embed field type
interface DiscordField {
  name: string;
  value: string;
  inline?: boolean;
}

// Stored incident data in KV
interface StoredIncident {
  pulsepointId: string;
  closed: boolean;
  messageId?: string;
  lastUpdated: string;
  callReceived?: string;
  displayIncidentCallType?: string;
}

export class PulsePointWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    // Step 1: Fetch data from PulsePoint
    const pulsePointResponse = await step.do('Fetch PulsePoint data', async () => {
      const response = await fetch('https://web.pulsepoint.org/DB/giba.php?agency_id=EMS1201');
      if (!response.ok) {
        throw new Error(`Failed to fetch from PulsePoint: ${response.status}`);
      }
      
      return await response.json() as PulsePointResponse;
    });

    // Step 2: Decrypt and parse the PulsePoint data
    const incidents = await step.do('Decrypt and process PulsePoint data', async () => {
      //console.log("Decrypting PulsePoint data...");
      
      try {
        // Decrypt the data
        const decrypted = await decryptPulsePointData(pulsePointResponse);
        
        // Process incidents from the decrypted data
        const activeIncidents = decrypted.incidents?.active || [];
        const recentIncidents = decrypted.incidents?.recent || [];
        
        console.log(`Found ${activeIncidents.length} active incidents and ${recentIncidents.length} recent incidents`);
        
        // Add 'Closed' attribute to each incident
        for (const incident of activeIncidents) {
          incident.Closed = false;
        }
        
        for (const incident of recentIncidents) {
          incident.Closed = true;
        }
        
        // Combine active and recent incidents
        const allIncidents = [...activeIncidents, ...recentIncidents];
        
        // Add DisplayDispatchStatus to each unit and DisplayIncidentCallType to each incident
        for (const incident of allIncidents) {
          if (incident.Unit && Array.isArray(incident.Unit)) {
            for (const unit of incident.Unit) {
              unit.DisplayDispatchStatus = mapDispatchStatus(unit.PulsePointDispatchStatus);
            }
          }
          
          incident.DisplayIncidentCallType = mapIncidentCallType(incident.PulsePointIncidentCallType);
        }
        
        return allIncidents as PulsePointIncident[];
      } catch (error) {
        console.error("Error decrypting/processing data:", error);
        throw new Error(`Failed to decrypt PulsePoint data: ${error}`);
      }
    });

    // Step 3: Get all tracked incidents from KV
    const trackedIncidents = await step.do('Get tracked incidents from KV', async () => {
      // List all keys with the prefix 'incident:'
      const keys = await this.env.PULSEPOINT_KV.list({ prefix: 'incident:' });
      console.log(`Found ${keys.keys.length} tracked incidents in KV`);
      
      const incidents: Record<string, StoredIncident> = {};
      
      // Fetch each incident data
      for (const key of keys.keys) {
        const data = await this.env.PULSEPOINT_KV.get(key.name, 'json') as StoredIncident;
        if (data) {
          incidents[data.pulsepointId] = data;
          console.log(`Loaded incident ${data.pulsepointId} with message ID ${data.messageId}`);
        }
      }
      
      console.log(`Successfully loaded ${Object.keys(incidents).length} tracked incidents`);
      return incidents;
    });

    // Step 4: Process new incidents (ones we haven't seen before)
    const newIncidents = await step.do('Process new incidents', async () => {
      // Filter for incidents we haven't seen before
      const locationRegex = /.*(VANCOUVER|BURNABY|WESTMINSTER|SURREY|DELTA|BELCARRA|MAPLE RIDGE|RICHMOND|COQUITLAM|LANGLEY|ABBOTSFORD|CHILLIWACK|MISSION|YALE|ADDRESS NOT AVAILABLE).*/i;
      
      const newOnes = incidents.filter(incident => {
        const isNew = !trackedIncidents[incident.ID];
        const isMatch = incident.FullDisplayAddress && locationRegex.test(incident.FullDisplayAddress);
        
        if (!isNew) {
          console.log(`Incident ${incident.ID} already tracked, skipping`);
        }
        if (!isMatch && incident.FullDisplayAddress) {
          //console.log(`Incident ${incident.ID} address "${incident.FullDisplayAddress}" doesn't match location filter`);
        }
        
        return isNew && !incident.Closed && isMatch;
      });
      
      console.log(`Found ${newOnes.length} new incidents to process`);
      
      // Process each new incident
      for (const incident of newOnes) {
                    // Move messageId declaration to this scope to ensure it's available later
                    let messageId = `incident-${incident.ID}-${Date.now()}`;
        // Create and post to Discord
        const discordFields = buildDiscordFields(incident);
        const isStandby = incident.DisplayIncidentCallType === 'Standby';
        const webhookUrl = isStandby 
          ? this.env.DISCORD_STANDBY_WEBHOOK_URL 
          : this.env.DISCORD_WEBHOOK_URL;
        
        const embed = {
          title: incident.DisplayIncidentCallType,
          fields: discordFields,
          color: 0xf40a38, // Hexadecimal color code (red)
          footer: {
            text: `PulsePoint ID: ${incident.ID}`
          },
          url: `https://web.pulsepoint.org/?agencies=EMS1201&incident=${incident.ID}`,
          timestamp: incident.CallReceivedDateTime
        };
        
        try {
          // Post to Discord
          //console.log(`Creating new Discord message for incident ${incident.ID}`);
          //console.log(`Sending to webhook: ${webhookUrl}`);
          
          try {
            //console.log(`About to fetch Discord API for new incident ${incident.ID}`);
            //console.log(`Request body:`, JSON.stringify({ embeds: [embed] }).substring(0, 200) + '...');
            
            const response = await fetch(webhookUrl + "?wait=true", {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ embeds: [embed] })
            });
            
            //console.log(`Discord API response status: ${response.status} ${response.statusText}`);
            
            if (!response.ok) {
              console.error(`Discord API error: ${response.status} ${response.statusText}`);
              try {
                const errorText = await response.text();
                console.error(`Discord error details: ${errorText}`);
              } catch (e) {
                console.error(`Couldn't read error response: ${e}`);
              }
              continue;
            }
            
            // Try to get the message ID from the response - log everything for debugging
            const responseText = await response.text();
            //console.log(`Discord response for incident ${incident.ID}: [${responseText}]`);
            
            
            // Only try to parse as JSON if there's actual content
            if (responseText && responseText.trim() !== '') {
              try {
                const messageData = JSON.parse(responseText);
                //console.log(`Parsed response for incident ${incident.ID}:`, JSON.stringify(messageData));
                
                // Check for id directly or various possible locations based on Discord's API response format
                if (typeof messageData === 'object' && messageData !== null) {
                  if (messageData.id) {
                    messageId = messageData.id;
                    //console.log(`Found message ID directly: ${messageId}`);
                  } else if (messageData.message_id) {
                    messageId = messageData.message_id;
                    console.log(`Found message_id: ${messageId}`);
                  } else if (messageData.message && messageData.message.id) {
                    messageId = messageData.message.id;
                    console.log(`Found message.id: ${messageId}`);
                  } else {
                    console.log(`No message ID found in response. Keys available:`, Object.keys(messageData).join(', '));
                  }
                } else {
                  console.log(`Response is not an object:`, typeof messageData);
                }
              } catch (parseError) {
                console.error(`Error parsing Discord response for incident ${incident.ID}:`, parseError);
                console.log(`Raw response that failed to parse: [${responseText}]`);
              }
            } else {
              console.log(`Empty response from Discord for incident ${incident.ID}`);
            }
          } catch (fetchError) {
            console.error(`Error during fetch operation for new incident ${incident.ID}:`, fetchError);
            continue;
          }
          
          // Store the incident in KV
          await this.env.PULSEPOINT_KV.put(`incident:${incident.ID}`, JSON.stringify({
            pulsepointId: incident.ID,
            closed: false,
            messageId: messageId,
            lastUpdated: new Date().toISOString(),
            callReceived: incident.CallReceivedDateTime,
            displayIncidentCallType: incident.DisplayIncidentCallType
          }));
          
          //console.log(`Stored incident ${incident.ID} with message ID ${messageId}`);
        } catch (e) {
          console.error(`Error processing new incident ${incident.ID}:`, e);
        }
      }
      
      return newOnes.length;
    });

    // Step 5: Update existing open incidents
    const updatedOpenIncidents = await step.do('Update existing open incidents', async () => {
      // Find incidents that are still open in our tracking but have updates
      const openIncidents = incidents.filter(incident => {
        const tracked = trackedIncidents[incident.ID];
        const isTrackedAndOpen = tracked && !tracked.closed && !incident.Closed;
        
        if (isTrackedAndOpen) {
          //console.log(`Found open incident ${incident.ID} to update, message ID: ${tracked.messageId}`);
        }
        
        return isTrackedAndOpen;
      });
      
      console.log(`Found ${openIncidents.length} open incidents to update`);
      
      // Update each open incident
      let updateCount = 0;
      for (const incident of openIncidents) {
        const tracked = trackedIncidents[incident.ID];
        if (!tracked.messageId) continue;
        
        // Build updated fields
        const discordFields = buildDiscordFields(incident);
        
        // Create updated embed
        const embed = {
          title: incident.DisplayIncidentCallType,
          fields: discordFields,
          color: 0xf40a38, // Red
          footer: {
            text: `PulsePoint ID: ${incident.ID}`
          },
          url: `https://web.pulsepoint.org/?agencies=EMS1201&incident=${incident.ID}`,
          timestamp: incident.CallReceivedDateTime
        };
        
        // Check if we have a real Discord message ID or a fallback ID
        const isRealMessageId = !tracked.messageId.startsWith('incident-');
        const isStandby = incident.DisplayIncidentCallType === 'Standby';
        const baseWebhookUrl = isStandby ? this.env.DISCORD_STANDBY_WEBHOOK_URL : this.env.DISCORD_WEBHOOK_URL;
        
        try {
          let response;
          
          if (isRealMessageId) {
            // We have a real Discord message ID, attempt to update
            const updateUrl = `${baseWebhookUrl}/messages/${tracked.messageId}`;
            console.log(`Updating message ${tracked.messageId} for incident ${incident.ID}: ${updateUrl}`);
            
            try {
              response = await fetch(updateUrl, {
                method: 'PATCH',
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({ embeds: [embed] })
              });
              
              if (!response.ok) {
                // If updating fails (maybe the message was deleted), fall back to posting a new message
                console.error(`Failed to update message ${tracked.messageId}: ${response.status} ${response.statusText}`);
                // console.log(`Falling back to creating a new message for incident ${incident.ID}`);
                
                // response = await fetch(baseWebhookUrl, {
                //   method: 'POST',
                //   headers: {
                //     'Content-Type': 'application/json'
                //   },
                //   body: JSON.stringify({ embeds: [embed] })
                // });
                
                // Try to get a new message ID
                if (response.ok) {
                  const responseText = await response.text();
                  console.log(`Discord response for fallback message: [${responseText}]`);
                  
                  if (responseText && responseText.trim() !== '') {
                    try {
                      const messageData = JSON.parse(responseText);
                      if (messageData.id) {
                        tracked.messageId = messageData.id;
                        console.log(`Updated message ID to ${messageData.id}`);
                      }
                    } catch (e) {
                      console.log(`Couldn't parse fallback response as JSON`);
                    }
                  }
                }
              }
            } catch (e) {
              console.error(`Error updating message ${tracked.messageId}:`, e);
              continue;
            }
          } else {
            // We have a fallback ID, create a new message
            console.log(`Cannot update with fallback ID ${tracked.messageId}, creating new message for incident ${incident.ID}`);
            //console.log(`Sending to webhook: ${baseWebhookUrl}`);
            
            try {
              //console.log(`About to fetch Discord API for incident ${incident.ID}`);
              //console.log(`Request body:`, JSON.stringify({ embeds: [embed] }));
              
              response = await fetch(baseWebhookUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({ embeds: [embed] })
              });
              
              //console.log(`Discord API response status: ${response.status} ${response.statusText}`);
              
              // Try to get a real message ID this time
              if (response.ok) {
                try {
                  const text = await response.text();
                  //console.log(`Discord response for incident ${incident.ID}: [${text}]`);
                  
                  if (text && text.trim() !== '') {
                    try {
                      const messageData = JSON.parse(text);
                      //console.log(`Parsed Discord response for incident ${incident.ID}:`, JSON.stringify(messageData));
                      
                      if (messageData && messageData.id) {
                        tracked.messageId = messageData.id;
                        //console.log(`Got real message ID ${messageData.id} for incident ${incident.ID}`);
                      }
                    } catch (parseError) {
                      console.log(`Still couldn't get real message ID for incident ${incident.ID}: ${parseError}`);
                    }
                  }
                } catch (e) {
                  console.log(`Error reading Discord response for incident ${incident.ID}: ${e}`);
                }
              } else {
                console.error(`Discord API failed with status ${response.status} for incident ${incident.ID}`);
                try {
                  const errorText = await response.text();
                  console.error(`Discord error details: ${errorText}`);
                } catch (e) {
                  console.error(`Couldn't read error response: ${e}`);
                }
              }
            } catch (error) {
              console.error(`Error during fetch operation for incident ${incident.ID}: ${error}`);
              continue;
            }
          }
          
          if (!response.ok) {
            console.error(`Discord API error for incident ${incident.ID}: ${response.status} ${response.statusText}`);
            continue;
          }
          
          // Update the KV record with latest timestamp
          await this.env.PULSEPOINT_KV.put(`incident:${incident.ID}`, JSON.stringify({
            ...tracked,
            lastUpdated: new Date().toISOString()
          }));
          
          updateCount++;
        } catch (e) {
          console.error(`Error updating open incident ${incident.ID}:`, e);
        }
      }
      
      return updateCount;
    });

    // Step 6: Process newly closed incidents
    const closedIncidents = await step.do('Process newly closed incidents', async () => {
      // Find incidents that are now closed but were open in our tracking
      const newlyClosed = incidents.filter(incident => {
        const tracked = trackedIncidents[incident.ID];
        return tracked && !tracked.closed && incident.Closed;
      });
      
      console.log(`Found ${newlyClosed.length} newly closed incidents`);
      
      // Update each newly closed incident
      let closedCount = 0;
      for (const incident of newlyClosed) {
        const tracked = trackedIncidents[incident.ID];
        if (!tracked.messageId) continue;
        
        // Build updated fields
        const discordFields = buildDiscordFields(incident);
        
        // Create updated embed
        const embed = {
          title: `${incident.DisplayIncidentCallType} - Closed`,
          fields: discordFields,
          color: 0x818182,
          footer: {
            text: `PulsePoint ID: ${incident.ID}`
          },
          url: `https://web.pulsepoint.org/?agencies=EMS1201&incident=${incident.ID}`,
          timestamp: incident.CallReceivedDateTime
        };
        
        // Check if we have a real Discord message ID or a fallback ID
        const isRealMessageId = !tracked.messageId.startsWith('incident-');
        const isStandby = incident.DisplayIncidentCallType === 'Standby';
        const baseWebhookUrl = isStandby ? this.env.DISCORD_STANDBY_WEBHOOK_URL : this.env.DISCORD_WEBHOOK_URL;
        
        try {
          let response;
          
          if (isRealMessageId) {
            // We have a real Discord message ID, attempt to update
            console.log(`Updating message ${tracked.messageId} to mark incident ${incident.ID} as closed`);
            const updateUrl = `${baseWebhookUrl}/messages/${tracked.messageId}`;
            
            response = await fetch(updateUrl, {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ embeds: [embed] })
            });
          } else {
            // We have a fallback ID, create a new message
            console.log(`Cannot update with fallback ID ${tracked.messageId}, creating new closed message for incident ${incident.ID}`);
            
            response = await fetch(baseWebhookUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ embeds: [embed] })
            });
          }
          
          if (!response.ok) {
            console.error(`Discord API error for closed incident ${incident.ID}: ${response.status} ${response.statusText}`);
            continue;
          }
          
          // Update the KV record to mark as closed
          await this.env.PULSEPOINT_KV.put(`incident:${incident.ID}`, JSON.stringify({
            ...tracked,
            closed: true,
            lastUpdated: new Date().toISOString()
          }));
          
          closedCount++;
        } catch (e) {
          console.error(`Error updating closed incident ${incident.ID}:`, e);
        }
      }
      
      return closedCount;
    });

    // Step 7: Check for expired incidents (open for too long)
    const expiredIncidents = await step.do('Check for expired incidents', async () => {
      // Find incidents that have been open for more than 24 hours
      const now = new Date();
      const expiredIds = [];
      
      for (const [id, data] of Object.entries(trackedIncidents)) {
        if (data.closed) continue;
        
        const lastUpdated = new Date(data.lastUpdated);
        const hoursElapsed = (now.getTime() - lastUpdated.getTime()) / (1000 * 60 * 60);
        
        // If it's been more than 24 hours, mark as expired
        if (hoursElapsed > 24) {
          expiredIds.push(id);
        }
      }
      
      console.log(`Found ${expiredIds.length} expired incidents`);
      
      // Update each expired incident
      let expiredCount = 0;
      for (const id of expiredIds) {
        const tracked = trackedIncidents[id];
        if (!tracked.messageId) continue;
        
        // Get the last known incident data
        let incidentData = incidents.find(inc => inc.ID === id);
        if (!incidentData) {
          // If not in current data, create a minimal version based on stored data
          incidentData = {
            ID: id,
            CallReceivedDateTime: tracked.callReceived,
            DisplayIncidentCallType: tracked.displayIncidentCallType,
            FullDisplayAddress: "Address information no longer available",
            Unit: []
          };
        }
        
        // Build updated fields
        const discordFields = buildDiscordFields(incidentData);
        
        // Create updated embed
        const embed = {
          title: `${tracked.displayIncidentCallType} - Expired`,
          fields: discordFields,
          color: 0x818182,
          footer: {
            text: `PulsePoint ID: ${id}`
          },
          url: `https://web.pulsepoint.org/?agencies=EMS1201&incident=${id}`,
          timestamp: tracked.callReceived
        };
        
        // Check if we have a real Discord message ID or a fallback ID
        const isRealMessageId = !tracked.messageId.startsWith('incident-');
        const isStandby = tracked.displayIncidentCallType === 'Standby';
        const baseWebhookUrl = isStandby ? this.env.DISCORD_STANDBY_WEBHOOK_URL : this.env.DISCORD_WEBHOOK_URL;
        
        try {
          let response;
          
          if (isRealMessageId) {
            // We have a real Discord message ID, attempt to update
            console.log(`Updating message ${tracked.messageId} to mark incident ${id} as expired`);
            const updateUrl = `${baseWebhookUrl}/messages/${tracked.messageId}`;
            
            response = await fetch(updateUrl, {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ embeds: [embed] })
            });
          } else {
            // We have a fallback ID, create a new message
            console.log(`Cannot update with fallback ID ${tracked.messageId}, creating new expired message for incident ${id}`);
            
            response = await fetch(baseWebhookUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ embeds: [embed] })
            });
          }
          
          if (!response.ok) {
            console.error(`Discord API error for expired incident ${id}: ${response.status} ${response.statusText}`);
            continue;
          }
          
          // Update the KV record to mark as closed (expired)
          await this.env.PULSEPOINT_KV.put(`incident:${id}`, JSON.stringify({
            ...tracked,
            closed: true,
            lastUpdated: new Date().toISOString()
          }));
          
          expiredCount++;
        } catch (e) {
          console.error(`Error updating expired incident ${id}:`, e);
        }
      }
      
      return expiredCount;
    });

    // Step 8: Prune closed incidents from KV store
    const prunedIncidents = await step.do('Prune closed incidents from KV', async () => {
      // Find closed incidents that are older than 3 days
      const now = new Date();
      const cutoffDays = 3; // Keep closed incidents for 3 days before pruning
      const pruneIds = [];
      
      for (const [id, data] of Object.entries(trackedIncidents)) {
        if (!data.closed) continue;
        
        const lastUpdated = new Date(data.lastUpdated);
        const daysElapsed = (now.getTime() - lastUpdated.getTime()) / (1000 * 60 * 60 * 24);
        
        // If it's been more than the cutoff days, mark for pruning
        if (daysElapsed > cutoffDays) {
          pruneIds.push(id);
          console.log(`Marking incident ${id} for pruning, closed ${daysElapsed.toFixed(1)} days ago`);
        }
      }
      
      console.log(`Found ${pruneIds.length} closed incidents to prune from KV storage`);
      
      // Delete each incident from KV
      let prunedCount = 0;
      for (const id of pruneIds) {
        try {
          await this.env.PULSEPOINT_KV.delete(`incident:${id}`);
          console.log(`Pruned incident ${id} from KV storage`);
          prunedCount++;
        } catch (e) {
          console.error(`Error pruning incident ${id} from KV:`, e);
        }
      }
      
      return prunedCount;
    });

    // Return stats about the run
    return {
      totalIncidents: incidents.length,
      trackedIncidents: Object.keys(trackedIncidents).length,
      newIncidents: newIncidents,
      updatedOpenIncidents: updatedOpenIncidents,
      closedIncidents: closedIncidents,
      expiredIncidents: expiredIncidents,
      prunedIncidents: prunedIncidents,
      timestamp: new Date().toISOString()
    };
  }
}

// Helper function to build Discord fields for an incident
function buildDiscordFields(incident: PulsePointIncident): DiscordField[] {
  const fields: DiscordField[] = [
    {
      name: "Full Address",
      value: incident.FullDisplayAddress || "Address not available"
    }
  ];

  // Only process units if they exist
  if (incident.Unit && Array.isArray(incident.Unit)) {
    // On Scene units
    const onSceneUnits = incident.Unit.filter((unit) => unit.DisplayDispatchStatus === 'On Scene');
    if (onSceneUnits.length > 0) {
      fields.push({
        name: "On Scene",
        value: onSceneUnits.map((unit) => unit.UnitID).join(', '),
        inline: true
      });
    }

    // En Route units
    const enRouteUnits = incident.Unit.filter((unit) => unit.DisplayDispatchStatus === 'En Route');
    if (enRouteUnits.length > 0) {
      fields.push({
        name: "En Route",
        value: enRouteUnits.map((unit) => unit.UnitID).join(', '),
        inline: true
      });
    }

    // Transport units
    const transportUnits = incident.Unit.filter((unit) => unit.DisplayDispatchStatus === 'Transport');
    if (transportUnits.length > 0) {
      fields.push({
        name: "Transport",
        value: transportUnits.map((unit) => unit.UnitID).join(', '),
        inline: true
      });
    }

    // Dispatched units
    const dispatchedUnits = incident.Unit.filter((unit) => unit.DisplayDispatchStatus === 'Dispatched');
    if (dispatchedUnits.length > 0) {
      fields.push({
        name: "Dispatched",
        value: dispatchedUnits.map((unit) => unit.UnitID).join(', '),
        inline: true
      });
    }

    // Transport Arrived units
    const transportArrivedUnits = incident.Unit.filter((unit) => unit.DisplayDispatchStatus === 'Transport Arrived');
    if (transportArrivedUnits.length > 0) {
      fields.push({
        name: "Transport Arrived",
        value: transportArrivedUnits.map((unit) => unit.UnitID).join(', '),
        inline: true
      });
    }

    // Cleared units
    const clearedUnits = incident.Unit.filter((unit) => unit.DisplayDispatchStatus === 'Cleared');
    if (clearedUnits.length > 0) {
      fields.push({
        name: "Cleared",
        value: clearedUnits.map((unit) => unit.UnitID).join(', '),
        inline: true
      });
    }

    // Unknown status units
    const knownStatuses = ['On Scene', 'En Route', 'Cleared', 'Transport', 'Dispatched', 'Transport Arrived'];
    const unknownUnits = incident.Unit.filter((unit) => !knownStatuses.includes(unit.DisplayDispatchStatus || ''));
    if (unknownUnits.length > 0) {
      fields.push({
        name: "Unknown",
        value: unknownUnits.map((unit) => `${unit.UnitID} - ${unit.PulsePointDispatchStatus}`).join(', '),
        inline: true
      });
    }
  }

  // Last Updated timestamp
  fields.push({
    name: "Last Updated",
    value: `<t:${Math.floor(Date.now() / 1000)}:R>`,
    inline: false
  });

  return fields;
}

// Helper functions for mapping status codes
function mapDispatchStatus(status: string | undefined): string {
  if (!status) return 'Unknown';
  
  const statusMap: Record<string, string> = {
    'AR': 'Cleared',
    'ER': 'En Route',
    'OS': 'On Scene',
    'TR': 'Transport',
    'DP': 'Dispatched',
    'AK': 'Dispatched',
    'TA': 'Transport Arrived'
  };
  return statusMap[status] || 'Unknown';
}

function mapIncidentCallType(callType: string | undefined): string {
  if (!callType) return 'Unknown';
  
  const typeMap: Record<string, string> = {
    'ME': 'Medical Emergency',
    'TC': 'Traffic Collision',
    'STBY': 'Standby',
    'TCE': 'Expanded Traffic Collision',
    'CSR': 'Confined Space',
    'HMR': 'Hazardous Materials Response'
  };
  return typeMap[callType] || 'Unknown';
}

// PulsePoint decryption function
async function decryptPulsePointData(data: PulsePointResponse): Promise<any> {
  // original logic from https://gist.github.com/Davnit/4a6e7dd94d97a05c3806b306e3d838c6
  //console.log("Starting decryption with data:", Object.keys(data).join(', '));
  
  try {
    // Base64 decode the ciphertext
    const ct = atob(data.ct);
    
    // Convert hex strings to byte arrays
    const iv = hexToBytes(data.iv);
    const salt = hexToBytes(data.s);
    
    // Build the password (from the original code)
    let t = "";
    const e = "CommonIncidents";
    t += e[13] + e[1] + e[2] + "brady" + "5" + "r" + e.toLowerCase()[6] + e[5] + "gs";
    
    // Calculate a key from the password using MD5 (as in the original code)
    let key = new Uint8Array(0);
    let block: ArrayBuffer | null = null;
    
    while (key.length < 32) {
      const hasher = await crypto.subtle.digest(
        'MD5', 
        concatenateArrays(
          block ? new Uint8Array(block) : new Uint8Array(0),
          new TextEncoder().encode(t),
          salt
        )
      );
      
      block = hasher;
      key = concatenateArrays(key, new Uint8Array(block));
    }
    
    // Truncate key to 32 bytes if longer
    if (key.length > 32) {
      key = key.slice(0, 32);
    }
    
    // Import the key for AES-CBC decryption
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      key.buffer,
      { name: 'AES-CBC' },
      false,
      ['decrypt']
    );
    
    // Convert the ciphertext to a Uint8Array
    const ctArray = new Uint8Array(ct.length);
    for (let i = 0; i < ct.length; i++) {
      ctArray[i] = ct.charCodeAt(i);
    }
    
    // Decrypt the data
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-CBC', iv },
      cryptoKey,
      ctArray
    );
    
    // Decode and process the decrypted data
    const decoder = new TextDecoder();
    let out = decoder.decode(decrypted);
    
    // Debug the first part of the decrypted output
    //console.log("First 100 chars of decrypted data:", out.substring(0, 100));
    
    // Strip off extra bytes and wrapper quotes
    const quoteEndIndex = out.lastIndexOf('"');
    out = out.substring(1, quoteEndIndex >= 0 ? quoteEndIndex : out.length);
    
    // Un-escape quotes
    out = out.replace(/\\"/g, '"');
    
    // Parse JSON
    const parsed = JSON.parse(out);
    //console.log("Successfully decrypted and parsed data");
    return parsed;
  } catch (error: unknown) {
    console.error("Error during decryption:", error);
    
    // Type guard to check if error is an Error object
    if (error instanceof Error) {
      throw new Error(`Decryption failed: ${error.message}`);
    } else {
      throw new Error(`Decryption failed: ${String(error)}`);
    }
  }
}

// Helper functions for byte manipulation
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function concatenateArrays(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((len, arr) => len + arr.length, 0);
  const result = new Uint8Array(totalLength);
  
  let offset = 0;
  for (const array of arrays) {
    result.set(array, offset);
    offset += array.length;
  }
  
  return result;
}

// Export both the entrypoint and a fetch handler
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // This could be used to manually trigger the workflow or check its status
    return new Response("PulsePoint Workflow is running on schedule", {
      headers: { "Content-Type": "text/plain" },
    });
  },
  
  // This is where you would set up a scheduled trigger - Cloudflare can trigger this workflow
  // on a schedule using Cron Triggers
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    // You would implement this if you want to trigger the workflow on a schedule
    //console.log("PulsePoint workflow triggered by schedule");
    
    // Create a new instance of the workflow
    try {
      const instance = await env.PULSEPOINT_WORKFLOW.create();
      console.log(`Started workflow instance: ${instance.id}`);
    } catch (error) {
      console.error("Failed to start workflow:", error);
    }
  }
};