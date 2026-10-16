import { classify } from '../src/routing.js';
import { routingCases } from '../fixtures/routing-cases.js';

if (typeof process.env.OPENAI_API_KEY !== 'string' || process.env.OPENAI_API_KEY.length === 0) throw new Error('Missing OPENAI_API_KEY');
const results = [];
for (let start = 0; start < routingCases.length; start += 4) {
  const cases = routingCases.slice(start, start + 4);
  const outcomes = await Promise.allSettled(cases.map(async sample => {
    const began = Date.now();
    const answer = await classify(process.env, sample.context, []);
    return { name: sample.name, expected: sample.expected, actual: answer.target, confidence: answer.confidence, requestId: answer.requestId, ms: Date.now() - began, passed: answer.target === sample.expected };
  }));
  for (let index = 0; index < outcomes.length; index++) {
    const outcome = outcomes[index];
    if (outcome.status === 'fulfilled') results.push(outcome.value);
    else results.push({ name: cases[index].name, passed: false, error: String(outcome.reason) });
  }
}
for (const result of results) console.log(JSON.stringify(result));
const passed = results.filter(result => result.passed).length;
console.log(JSON.stringify({ passed, total: results.length }));
if (passed !== results.length) process.exitCode = 1;
