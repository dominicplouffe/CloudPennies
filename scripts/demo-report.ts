// Prints the analysis of the built-in demo account. Handy for eyeballing the engine:
//   npx tsx scripts/demo-report.ts
import { demoSnapshot } from '../src/core/demo';
import { analyze } from '../src/core/analysis';

const r = analyze(demoSnapshot());
console.log(r.briefing.headline);
console.log(r.briefing.story.join('\n\n'));
console.log('\nDRIVERS');
for (const d of r.briefing.drivers) console.log(' ', d.service, Math.round(d.delta), d.why);
console.log('\nANOMALIES');
for (const a of r.anomalies) console.log(` [${a.kind}/${a.severity}${a.ongoing ? '/ongoing' : ''}] ${a.title} :: ${a.summary}`);
console.log('\nINSIGHTS total', Math.round(r.totalMonthlySavings));
for (const i of r.insights) console.log(` ${i.urgent ? '!' : ' '} $${Math.round(i.monthlySavings)} [${i.category}/${i.source}] ${i.title}`);
console.log('\nCOMMITMENTS', JSON.stringify({ ...r.commitments, expirations: r.commitments.expirations.map((e) => [e.label, e.daysLeft, Math.round(e.monthlyExposure)]) }));
console.log('\nMTD', Math.round(r.briefing.mtd), 'projected', Math.round(r.briefing.projected), 'prev month', Math.round(r.briefing.prevMonthTotal), 'last30', Math.round(r.briefing.last30));
