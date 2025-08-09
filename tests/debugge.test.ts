import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { spawn } from "node:child_process";
import CDP from "chrome-remote-interface";
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

let activeProcesses: any[] = [];

describe('MCP Debugger Server', () => {
  let testScript: string;

  beforeAll(() => {
    testScript = join(process.cwd(), 'test-script.js');
    writeFileSync(testScript, `
console.log("Test script starting");

function add(a, b) {
    const result = a + b;
    console.log(\`Adding \${a} + \${b} = \${result}\`);
    return result;
}

function main() {
    console.log("Main function called");
    const x = 5;
    const y = 3;
    const sum = add(x, y);
    console.log(\`Final result: \${sum}\`);
    
    // Keep the process alive for debugging
    setInterval(() => {
        console.log("Still running...");
    }, 1000);
}

// Wait longer and keep process alive
setTimeout(main, 500);
`);
  });

  afterEach(() => {
    activeProcesses.forEach(proc => {
      if (proc && !proc.killed) {
        proc.kill('SIGKILL');
      }
    });
    activeProcesses = [];
  });

  describe('debug/start_session tool', () => {
    it('should spawn a Node process with inspector and return session info', async () => {
      const sessionData = await testStartSession({
        entry: testScript,
        runner: 'node',
        inspectBrk: true
      });

      expect(sessionData).toHaveProperty('sessionId');
      expect(sessionData).toHaveProperty('wsUrl');
      expect(sessionData).toHaveProperty('pid');
      expect(sessionData.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+$/);
      expect(sessionData.runner).toBe('node');
      expect(sessionData.entry).toBe(testScript);
    }, 15000);

    it('should be able to connect to the CDP WebSocket', async () => {
      const sessionData = await testStartSession({
        entry: testScript,
        runner: 'node',
        inspectBrk: true
      });

      const client = await CDP({ target: sessionData.wsUrl });
      const { Debugger, Runtime } = client;
      
      await Debugger.enable();
      await Runtime.enable();
      
      const { result } = await Runtime.evaluate({ expression: '1 + 1' });
      expect(result.value).toBe(2);

      await client.close();
      
      const proc = activeProcesses.find(p => p.pid === sessionData.pid);
      if (proc && !proc.killed) {
        proc.kill('SIGKILL');
      }
    }, 15000);
  });
});

async function testStartSession(params: {
  entry: string;
  runner?: string;
  inspectBrk?: boolean;
  args?: string[];
  cwd?: string;
}): Promise<{
  sessionId: string;
  wsUrl: string;
  pid: number;
  runner: string;
  entry: string;
}> {
  const { entry, runner = 'node', inspectBrk = true, args = [], cwd } = params;

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
    default: 
      nodeCmd = "node";
      nodeArgs = [inspectBrk ? "--inspect-brk" : "--inspect", entry, ...args];
      break;
  }

  const child = spawn(nodeCmd, nodeArgs, {
    cwd: cwd || process.cwd(),
    stdio: ["ignore", "pipe", "pipe"]
  });

  activeProcesses.push(child);

  const wsUrl: string = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Timeout waiting for inspector WebSocket URL"));
    }, 10000);

    let stderr = "";

    child.stderr.on("data", (chunk) => {
      const data = chunk.toString();
      stderr += data;
      console.log('Stderr:', data);
      const match = stderr.match(/ws:\/\/[^\s]+/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[0]);
      }
    });

    child.stdout.on("data", (chunk) => {
      console.log('Stdout:', chunk.toString());
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

  const sessionId = `${process.pid}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;


  return {
    sessionId,
    wsUrl,
    pid: child.pid!,
    runner,
    entry,
  };
}
