import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { singletonFixture } from './helpers/singleton.js';

let httpServer: HttpServer;
let definition: ServerDefinition;
let sessions: Map<string, StreamableHTTPServerTransport>;
let calls: number;
let failure: { status: number; body: string } | undefined;

beforeEach(async () => {
  sessions = new Map();
  calls = 0;
  failure = undefined;
  const app = express();
  app.use(express.json());
  app.post('/mcp', async (request, response) => {
    if (failure) {
      response.status(failure.status).type('text/plain').send(failure.body);
      return;
    }
    const sessionId = request.headers['mcp-session-id'];
    if (typeof sessionId === 'string') {
      const transport = sessions.get(sessionId);
      if (!transport) {
        response.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
        return;
      }
      await transport.handleRequest(request, response, request.body);
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: (id) => void sessions.set(id, transport),
    });
    const server = new McpServer({ name: 'expiring', version: '1' });
    server.registerTool('count', { inputSchema: {} }, async () => {
      calls++;
      return { content: [{ type: 'text', text: String(calls) }] };
    });
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  });
  app.delete('/mcp', (_request, response) => void response.sendStatus(204));
  app.get('/mcp', (_request, response) => void response.sendStatus(405));
  httpServer = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => httpServer.once('listening', resolve));
  const { port } = httpServer.address() as AddressInfo;
  definition = {
    name: 'expiring',
    command: { kind: 'http', url: new URL(`http://127.0.0.1:${port}/mcp`) },
    lifecycle: { mode: 'keep-alive' },
  };
});

afterEach(async () => {
  httpServer.closeAllConnections();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

it('starts a new MCP session and replays once when the server expires the session', async () => {
  const f = await singletonFixture();
  try {
    const client = f.client(definition);
    await client.callTool({ server: 'expiring', tool: 'count' });
    sessions.clear();
    await expect(client.callTool({ server: 'expiring', tool: 'count' })).resolves.toMatchObject({
      content: [{ text: '2' }],
    });
    expect(sessions.size).toBe(1);
  } finally {
    await f.close();
  }
});

it('reports the HTTP status and body and reconnects on the next operation after an HTTP failure', async () => {
  const f = await singletonFixture();
  try {
    const client = f.client(definition);
    await client.callTool({ server: 'expiring', tool: 'count' });
    failure = { status: 503, body: 'upstream   maintenance' };
    await expect(client.callTool({ server: 'expiring', tool: 'count' })).rejects.toThrow(
      'HTTP 503 Service Unavailable: upstream maintenance'
    );
    failure = undefined;
    await expect(client.callTool({ server: 'expiring', tool: 'count' })).resolves.toMatchObject({
      content: [{ text: '2' }],
    });
    expect(sessions.size).toBe(2);
    expect(calls).toBe(2);
  } finally {
    await f.close();
  }
});

it('shares one HTTP connection across callers in different directories and sessions', async () => {
  const f = await singletonFixture();
  const previous = { PWD: process.env.PWD, CALLER_SESSION: process.env.CALLER_SESSION };
  try {
    process.env.PWD = '/first';
    process.env.CALLER_SESSION = 'one';
    await f.client(definition).callTool({ server: 'expiring', tool: 'count' });
    process.env.PWD = '/second';
    process.env.CALLER_SESSION = 'two';
    await f.client(definition).callTool({ server: 'expiring', tool: 'count' });
    expect(f.host.status().servers).toHaveLength(1);
    expect(sessions.size).toBe(1);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await f.close();
  }
});
