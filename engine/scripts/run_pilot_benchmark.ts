import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { benchmarkMarkdown, runBenchmark } from '../src/pilot/benchmark.ts';

const count = process.argv[2] == null ? 1_000 : Number(process.argv[2]);
const metrics = runBenchmark(count);
const outputDirectory = path.resolve(process.env.BENCHMARK_OUTPUT_DIR ?? 'var/pilot_benchmark');
await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(path.join(outputDirectory, 'benchmark.json'), `${JSON.stringify(metrics, null, 2)}\n`),
  writeFile(path.join(outputDirectory, 'benchmark.md'), benchmarkMarkdown(metrics)),
]);
console.log(JSON.stringify(metrics, null, 2));
if (metrics.falsePositives || metrics.falseNegatives || metrics.dollarAccuracy < 1) {
  process.exitCode = 1;
}
