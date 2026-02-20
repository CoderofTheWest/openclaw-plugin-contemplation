const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const InquiryStore = require('../lib/inquiry');
const extractor = require('../lib/extractor');

test('extractor emits gaps for keyword hit', () => {
  const gaps = extractor.identifyGaps({
    messages: [{ role: 'user', content: 'I am curious how this pattern works over time.' }],
    entropy: 0.1,
    extractionConfig: {
      entropyThreshold: 0.5,
      keywords: ['curious'],
      maxGapsPerExchange: 2
    },
    source: 'exchange_1'
  });

  assert.equal(gaps.length > 0, true);
  assert.equal(gaps[0].source, 'exchange_1');
});

test('inquiry store schedules pass 2 after completing pass 1', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'contemplation-test-'));
  const store = new InquiryStore(base, 'agentA', {
    '1': { delayMs: 0 },
    '2': { delayMs: 1000 },
    '3': { delayMs: 1000 }
  });

  const inquiry = store.addInquiry({ question: 'What is unknown?', source: 'src', entropy: 0.8, context: 'ctx' });
  const updated = store.completePass(inquiry.id, 1, 'pass1 output');
  const pass2 = updated.passes.find(p => p.number === 2);

  assert.ok(pass2.scheduled);
  assert.equal(pass2.output, null);
});
