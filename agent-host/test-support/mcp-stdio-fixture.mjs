// 真实 stdio MCP 测试服务器：仅用于 mcp-tools 的端到端测试，不接入产品。
// 行分隔 JSON-RPC；提供 echo（回显参数与可见环境变量名）和 flaky（标注为只读/非只读）两个工具。
import readline from 'node:readline';

const tools = [
  {
    name: 'echo',
    title: '回显',
    description: 'Echo arguments and visible environment variable names.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'write_note',
    description: 'Pretend to write a note.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    annotations: { readOnlyHint: false },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined || !message.method) return;
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } } });
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools } });
  } else if (message.method === 'tools/call') {
    const args = message.params.arguments ?? {};
    if (message.params.name === 'echo') {
      const visible = Object.keys(process.env).sort();
      send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ args, visible }) }] } });
    } else {
      send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'failed on purpose' }], isError: true } });
    }
  } else {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } });
  }
});
