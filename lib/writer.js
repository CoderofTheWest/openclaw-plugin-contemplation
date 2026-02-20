const fs = require('fs');
const path = require('path');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function appendGrowthVector(growthVectorsPath, inquiry) {
  ensureDir(path.dirname(growthVectorsPath));

  const existing = readJson(growthVectorsPath, { vectors: [] });
  existing.vectors = existing.vectors || [];

  const pass3 = (inquiry.passes || []).find(p => p.number === 3);
  existing.vectors.push({
    id: `gv_${inquiry.id}`,
    inquiryId: inquiry.id,
    question: inquiry.question,
    source: inquiry.source,
    entropy: inquiry.entropy,
    insight: pass3?.output || '',
    completed: inquiry.completed || new Date().toISOString(),
    created: inquiry.created
  });

  existing.updated = new Date().toISOString();
  fs.writeFileSync(growthVectorsPath, JSON.stringify(existing, null, 2));
}

function writeInsightFile(insightsPath, inquiry) {
  ensureDir(insightsPath);
  const outPath = path.join(insightsPath, `${inquiry.id}.json`);
  fs.writeFileSync(outPath, JSON.stringify(inquiry, null, 2));
}

module.exports = {
  appendGrowthVector,
  writeInsightFile
};
