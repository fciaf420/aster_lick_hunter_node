#!/usr/bin/env tsx

import { spawn } from 'child_process';
import { colors, log, logSection } from './utils/test-helpers';

interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  output?: string;
}

async function runTest(testFile: string, name: string): Promise<TestResult> {
  const startTime = Date.now();

  return new Promise((resolve) => {
    const child = spawn('tsx', [testFile], {
      stdio: 'pipe',
      env: { ...process.env, FORCE_COLOR: '1' }
    });

    let output = '';

    child.stdout.on('data', (data) => {
      output += data.toString();
    });

    child.stderr.on('data', (data) => {
      output += data.toString();
    });

    child.on('close', (code) => {
      const duration = Date.now() - startTime;
      resolve({
        name,
        passed: code === 0,
        duration,
        output
      });
    });
  });
}

async function main() {
  console.clear();
  log('🚀 RUNNING ALL TESTS', colors.cyan + colors.bold);
  log('=' .repeat(60), colors.cyan);

  const tests = [
    { file: 'tests/core/hunter.test.ts', name: 'Hunter' },
    { file: 'tests/core/position-manager.test.ts', name: 'Position Manager' },
    { file: 'tests/core/rate-limit.test.ts', name: 'Rate Limit' },
    { file: 'tests/core/websocket.test.ts', name: 'WebSocket' },
    { file: 'tests/core/error-logging.test.ts', name: 'Error Logging' },
    { file: 'tests/core/hunter-pending-orders.test.ts', name: 'Hunter Pending Orders' },
    { file: 'tests/core/hunter-fallback.test.ts', name: 'Hunter Fallback' },
    { file: 'tests/core/test-pending-order-fix.ts', name: 'Pending Order Fix' },
    { file: 'tests/core/position-mode-retry.test.ts', name: 'Position Mode Retry' },
    { file: 'tests/core/position-mode-sync.test.ts', name: 'Position Mode Sync' },
    { file: 'tests/core/cross-symbol-test.ts', name: 'Cross-Symbol TP/SL' },
    { file: 'tests/core/multi-position.test.ts', name: 'Multi-Position' },
    { file: 'tests/core/exchange-golden.test.ts', name: 'Exchange Golden Requests' },
    { file: 'tests/core/exchange-registry.test.ts', name: 'Exchange Registry' },
    { file: 'tests/core/lighter-bot-flow.test.ts', name: 'Lighter Bot Flow' },
    { file: 'tests/integration/trading-flow.test.ts', name: 'Integration' }
  ];

  const results: TestResult[] = [];

  for (const test of tests) {
    log(`\nRunning ${test.name} tests...`, colors.blue);
    const result = await runTest(test.file, test.name);
    results.push(result);

    if (result.passed) {
      log(`✅ ${test.name} passed (${(result.duration / 1000).toFixed(2)}s)`, colors.green);
    } else {
      log(`❌ ${test.name} failed`, colors.red);
      if (result.output) {
        console.log(result.output);
      }
    }
  }

  logSection('Test Summary');

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

  log(`Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`,
      failed > 0 ? colors.red : colors.green);
  log(`Total Duration: ${(totalDuration / 1000).toFixed(2)}s`, colors.gray);

  if (failed > 0) {
    log('\nFailed tests:', colors.red);
    results.filter(r => !r.passed).forEach(r => {
      log(`  - ${r.name}`, colors.red);
    });
    process.exit(1);
  } else {
    log('\n✨ All tests passed!', colors.green + colors.bold);
  }
}

if (require.main === module) {
  main().catch(console.error);
}