/**
 * A minimal MCP server over stdio, used as a test fixture.
 * Implements just initialize / tools/list / tools/call.
 */
import { createInterface } from 'node:readline';

const TOOLS = [
  {
    name: 'ping',
    description: 'Returns pong, optionally echoing a message.',
    inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
  },
  {
    name: 'add',
    description: 'Adds two numbers.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
  {
    name: 'explode',
    description: 'Always reports an error, to exercise the error path.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

// Servers are allowed to log here; the client must not try to parse it.
process.stderr.write('fixture server up\n');

createInterface({ input: process.stdin }).on('line', (line) => {
  const text = line.trim();
  if (!text) return;

  let req;
  try {
    req = JSON.parse(text);
  } catch {
    return;
  }
  if (req.id === undefined) return; // notification

  const reply = (result) => send({ jsonrpc: '2.0', id: req.id, result });

  switch (req.method) {
    case 'initialize':
      return reply({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '0.0.1' },
      });

    case 'tools/list':
      return reply({ tools: TOOLS });

    case 'tools/call': {
      const { name, arguments: args = {} } = req.params ?? {};
      if (name === 'ping') {
        return reply({ content: [{ type: 'text', text: `pong ${args.message ?? ''}`.trim() }] });
      }
      if (name === 'add') {
        return reply({ content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }] });
      }
      if (name === 'explode') {
        return reply({ content: [{ type: 'text', text: 'deliberate failure' }], isError: true });
      }
      return send({ jsonrpc: '2.0', id: req.id, error: { code: -32602, message: `unknown tool: ${name}` } });
    }

    default:
      return send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } });
  }
});
