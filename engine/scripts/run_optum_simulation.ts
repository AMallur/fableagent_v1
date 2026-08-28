// Optum submission simulation. See docs/PRE_PILOT_QUALIFICATION.md.
//
//   node scripts/run_optum_simulation.ts
//
// Needs no credentials and no network: it starts a mock payer on localhost and
// drives the real connector against it.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { 'output-dir': { type: 'string' } } });

const { runOptumSimulation, formatOptumSimulationReport } =
  await import('../src/qualification/optum_simulation.ts');

const report = await runOptumSimulation();
const outputDirectory = path.resolve(values['output-dir'] ?? 'var/qualification/optum');
await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(path.join(outputDirectory, 'optum.json'), `${JSON.stringify(report, null, 2)}\n`),
  writeFile(path.join(outputDirectory, 'optum.md'), `${formatOptumSimulationReport(report)}\n`),
]);

console.log(formatOptumSimulationReport(report));
if (!report.passed) {
  console.error('\nFAILED: the connector did not behave as required under one or more failures');
  process.exitCode = 1;
}
