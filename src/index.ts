import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "node:child_process";
import { z } from "zod";
import CDP from "chrome-remote-interface";

type Session = {
  id: string;
  wsUrl: string;
  client: CDP.Client;
  process?: any;
  breakpoints: Map<string, { id: string; file: string; line: number; column?: number }>;
  lastPaused?: any;
};

const sessions = new Map<string, Session>();

const server = new McpServer({
  name: "debuggee",
  version: "0.1.0",
  capabilities: {
    resources: {},
    tools: {},
  },
});


const StartSessionSchema = z.object({
  entry: z.string().describe("Path to the main script to debug"),
  args: z.array(z.string()).default([]).describe("Command line arguments for the script"),
  cwd: z.string().optional().describe("Working directory (defaults to current)"),
  inspectBrk: z.boolean().default(true).describe("Use --inspect-brk to pause on first line"),
  runner: z.enum(["node", "tsx", "ts-node"]).default("node").describe("Runtime to use"),
});

function generateSessionId(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

server.tool(
  "debug/start_session", 
  {
    description: "Start a new debugging session by spawning a Node process with inspector",
    inputSchema: StartSessionSchema.shape,
  },
  async ({ entry, args, cwd, inspectBrk, runner }) => {
    try {
      let nodeCmd: string;
      let nodeArgs: string[];

      switch (runner) {
        case "tsx":
          nodeCmd = "tsx";
          nodeArgs = [inspectBrk ? "--inspect-brk" : "--inspect", entry, ...args];
          break;
        case "ts-node":
          nodeCmd = "node";
          nodeArgs = [
            inspectBrk ? "--inspect-brk" : "--inspect",
            "-r", "ts-node/register",
            entry, ...args
          ];
          break;
        default: // "node"
          nodeCmd = "node";
          nodeArgs = [inspectBrk ? "--inspect-brk" : "--inspect", entry, ...args];
          break;
      }

      const child = spawn(nodeCmd, nodeArgs, {
        cwd: cwd || process.cwd(),
        stdio: ["ignore", "pipe", "pipe"]
      });

      const wsUrl: string = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Timeout waiting for inspector WebSocket URL"));
        }, 10000);

        let stderr = "";

        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
          const match = stderr.match(/ws:\/\/[^\s]+/);
          if (match) {
            clearTimeout(timeout);
            resolve(match[0]);
          }
        });

        child.on("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });

        child.on("exit", (code) => {
          if (code !== null) {
            clearTimeout(timeout);
            reject(new Error(`Process exited with code ${code} before inspector URL was found`));
          }
        });
      });

      const client = await CDP({ target: wsUrl });
      const { Debugger, Runtime } = client;
      
      await Debugger.enable();
      await Runtime.enable();

      const sessionId = generateSessionId();
      const session: Session = {
        id: sessionId,
        wsUrl,
        client,
        process: child,
        breakpoints: new Map(),
      };
        
      client.on("Debugger.paused", (event: any) => {
        session.lastPaused = event;
      });

      client.on("Debugger.resumed", () => {
        session.lastPaused = undefined;
      });

      sessions.set(sessionId, session);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              sessionId,
              wsUrl,
              pid: child.pid,
              runner,
              entry,
            }, null, 2),
          },
        ],
      };

    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Failed to start debug session: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);


async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("TypeScript Node Debugger MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});