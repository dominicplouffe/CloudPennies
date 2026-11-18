// Prints the investigation prompt for one demo anomaly: npx tsx scripts/demo-prompt.ts [title substring]
import { analyze } from '../src/core/analysis';
import { demoSnapshot } from '../src/core/demo';
import { investigationPrompt } from '../src/core/investigate';

const snap = demoSnapshot();
const want = (process.argv[2] ?? 'Log ingestion').toLowerCase();
const a = analyze(snap).anomalies.find((x) => x.title.toLowerCase().includes(want));
console.log(a ? investigationPrompt(a, snap) : `No demo anomaly matches "${want}"`);
