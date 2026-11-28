import { expect, test } from 'bun:test';
import { runDurableNodeCases } from './durable-node-test-runner.mjs';

test('official Durable long-run ToolPark signals, parked streaming and followUp handoff', async () => {
  expect(await runDurableNodeCases('./durable-longrun-cases.mjs')).toContain('fail 0');
}, 180000);

test('official Durable long-run TurnContinuationDoc onYield and creative CompactionTask.beforeCompact', async () => {
  expect(await runDurableNodeCases('./durable-longrun-compaction-cases.mjs')).toContain('fail 0');
}, 180000);
