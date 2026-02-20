const fs = require('fs');
const path = require('path');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

class InquiryStore {
  constructor(baseDir, agentId, passesConfig) {
    this.agentId = agentId || 'main';
    this.passesConfig = passesConfig || {};
    this.agentDir = path.join(baseDir, 'agents', this.agentId);
    this.filePath = path.join(this.agentDir, 'inquiries.json');
    ensureDir(this.agentDir);
    this.state = readJson(this.filePath, { inquiries: [] });
  }

  persist() {
    ensureDir(this.agentDir);
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  list() {
    return this.state.inquiries;
  }

  addInquiry({ question, source, entropy, context }) {
    const createdMs = Date.now();
    const id = `inq_${Math.random().toString(36).slice(2, 10)}`;
    const pass1Delay = this.passesConfig['1']?.delayMs || 0;

    const inquiry = {
      id,
      question,
      source: source || 'agent_end',
      entropy: Number.isFinite(entropy) ? entropy : 0,
      context: context || '',
      passes: [
        {
          number: 1,
          scheduled: iso(createdMs + pass1Delay),
          completed: null,
          output: null
        },
        {
          number: 2,
          scheduled: null,
          completed: null,
          output: null
        },
        {
          number: 3,
          scheduled: null,
          completed: null,
          output: null
        }
      ],
      tags: [],
      status: 'in_progress',
      created: iso(createdMs),
      persisted: false
    };

    this.state.inquiries.push(inquiry);
    this.persist();
    return inquiry;
  }

  getDuePass(nowMs = Date.now()) {
    for (const inquiry of this.state.inquiries) {
      if (inquiry.status !== 'in_progress') continue;
      for (const p of inquiry.passes) {
        if (!p.scheduled || p.completed) continue;
        if (Date.parse(p.scheduled) <= nowMs) {
          return { inquiry, passNumber: p.number };
        }
      }
    }
    return null;
  }

  completePass(inquiryId, passNumber, output) {
    const inquiry = this.state.inquiries.find(i => i.id === inquiryId);
    if (!inquiry) return null;

    const pass = inquiry.passes.find(p => p.number === passNumber);
    if (!pass) return null;

    pass.completed = new Date().toISOString();
    pass.output = output;

    const nextPassNumber = passNumber + 1;
    const nextPass = inquiry.passes.find(p => p.number === nextPassNumber);
    if (nextPass) {
      const delayMs = this.passesConfig[String(nextPassNumber)]?.delayMs || 0;
      nextPass.scheduled = new Date(Date.now() + delayMs).toISOString();
    } else {
      inquiry.status = 'completed';
      inquiry.completed = new Date().toISOString();
    }

    this.persist();
    return inquiry;
  }

  getCompletedUnpersisted() {
    return this.state.inquiries.filter(i => i.status === 'completed' && !i.persisted);
  }

  markPersisted(inquiryId) {
    const inquiry = this.state.inquiries.find(i => i.id === inquiryId);
    if (!inquiry) return false;
    inquiry.persisted = true;
    this.persist();
    return true;
  }
}

module.exports = InquiryStore;
