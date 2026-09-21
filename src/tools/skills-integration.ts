/**
 * Skills Integration for MCP Tools
 * Properly integrates skills with existing tool infrastructure
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
  TextContent
} from '@modelcontextprotocol/sdk/types.js';
import { SkillsManager } from '../skills/manager.js';
import { IJamfApiClient } from '../types/jamf-client.js';

// Store original handlers
let originalListToolsHandler: any = null;
let originalCallToolHandler: any = null;

export function integrateSkillsWithTools(
  server: Server,
  skillsManager: SkillsManager,
  jamfClient: IJamfApiClient
): void {
  // Capture the handlers registerTools() already registered. There is no
  // public SDK API to read back a handler you previously set, so this reads
  // the Protocol base class's own _requestHandlers map - the exact Map
  // setRequestHandler() itself writes to - before we replace those entries
  // below. (The previous approach read from a server.__handlers object that
  // nothing ever populated, so these were always undefined.)
  const requestHandlers = (server as any)._requestHandlers as
    | Map<string, (request: any, extra: any) => Promise<any>>
    | undefined;
  originalListToolsHandler = requestHandlers?.get('tools/list');
  originalCallToolHandler = requestHandlers?.get('tools/call');

  // SkillsManager.initialize() unconditionally calls createSkillContext(server),
  // and that function calls server.handleToolCall(...) internally - so the
  // object handed to initialize() must actually implement handleToolCall.
  // (Passing a plain context object here, as this file previously did, means
  // createSkillContext ends up calling `.handleToolCall` on that plain
  // object instead of a real server, which is exactly the
  // "server.handleToolCall is not a function" crash this fixes.)
  (server as any).handleToolCall = async (name: string, args: any) => {
    if (originalCallToolHandler) {
      return await originalCallToolHandler(
        { method: 'tools/call', params: { name, arguments: args } },
        {}
      );
    }
    throw new Error(`Tool ${name} not found`);
  };

  skillsManager.initialize(server as any);

  // Override the ListTools handler to include skills
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Get original tools
    let originalTools: Tool[] = [];
    if (originalListToolsHandler) {
      const result = await originalListToolsHandler({ method: 'tools/list', params: {} }, {});
      originalTools = result.tools || [];
    }

    // Get skill tools
    const skillTools = skillsManager.getMCPTools();

    // Combine and return
    return {
      tools: [...originalTools, ...skillTools]
    };
  });

  // Override the CallTool handler to include skills
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Check if this is a skill tool
    if (name.startsWith('skill_')) {
      const skillName = name.substring(6).replace(/_/g, '-');
      
      try {
        const result = await skillsManager.executeSkill(skillName, args);
        
        return {
          content: [
            {
              type: 'text',
              text: result.message
            } as TextContent
          ]
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Skill execution failed: ${error.message}`
            } as TextContent
          ],
          isError: true
        };
      }
    }

    // Not a skill tool, use original handler
    if (originalCallToolHandler) {
      return await originalCallToolHandler(request);
    }
    
    throw new Error(`Unknown tool: ${name}`);
  });
}

export function getSkillTools(skillsManager: SkillsManager): Tool[] {
  return skillsManager.getMCPTools();
}
