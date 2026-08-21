const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.sqlite');
const db = new Database(DB_PATH);

// Migration: if a submissions table already exists from before the multi-test
// rebuild, it won't have the columns this version expects (test_id, scores_json,
// etc.) — CREATE TABLE IF NOT EXISTS never upgrades an existing table's schema.
// Preserve the old table under a new name rather than silently failing or
// discarding data, then let the block below create a fresh correctly-shaped one.
const existingColumns = db.prepare(`PRAGMA table_info(submissions)`).all();
const hasTestId = existingColumns.some((c) => c.name === 'test_id');
if (existingColumns.length > 0 && !hasTestId) {
  console.warn('Migrating submissions table to the multi-test schema — old data preserved as submissions_legacy.');
  db.exec(`ALTER TABLE submissions RENAME TO submissions_legacy`);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    applicant TEXT NOT NULL,
    test_id TEXT NOT NULL,
    test_name TEXT NOT NULL,
    date TEXT NOT NULL,
    scores_json TEXT NOT NULL,
    headline_label TEXT NOT NULL,
    headline_score INTEGER NOT NULL,
    band TEXT NOT NULL,
    attention_passed INTEGER
  )
`);

function insertSubmission(record) {
  const stmt = db.prepare(`
    INSERT INTO submissions
      (applicant, test_id, test_name, date, scores_json, headline_label, headline_score, band, attention_passed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // Defensive: SQLite/better-sqlite3 refuses to bind NaN or undefined values and
  // throws instead of silently coercing them. If any upstream scoring bug ever
  // produces a non-finite number, sanitize it here rather than losing the whole
  // submission — log a warning so it's visible in the deployment logs either way.
  const safeScores = {};
  Object.entries(record.scores || {}).forEach(([k, v]) => {
    if (typeof v === 'number' && Number.isFinite(v)) {
      safeScores[k] = v;
    } else {
      console.warn(`insertSubmission: non-finite score for "${k}" (was ${v}), storing 0 instead.`);
      safeScores[k] = 0;
    }
  });
  let safeHeadlineScore = record.headlineScore;
  if (typeof safeHeadlineScore !== 'number' || !Number.isFinite(safeHeadlineScore)) {
    console.warn(`insertSubmission: non-finite headlineScore (was ${safeHeadlineScore}), storing 0 instead.`);
    safeHeadlineScore = 0;
  }

  stmt.run(
    record.applicant,
    record.testId,
    record.testName,
    record.date,
    JSON.stringify(safeScores),
    record.headlineLabel,
    safeHeadlineScore,
    record.band,
    record.attentionPassed === null || record.attentionPassed === undefined
      ? null
      : record.attentionPassed
      ? 1
      : 0
  );
}

// Duplicate check is per (applicant, test) — the same person may legitimately
// take the General assessment and one or more specialty scenario tests.
function hasSubmission(applicantId, testId) {
  const normalized = String(applicantId).trim().toLowerCase();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM submissions WHERE LOWER(TRIM(applicant)) = ? AND test_id = ?`
    )
    .get(normalized, testId);
  return row.n > 0;
}

function getAllSubmissions() {
  const rows = db.prepare(`SELECT * FROM submissions ORDER BY date DESC`).all();
  return rows.map((r) => ({
    applicant: r.applicant,
    testId: r.test_id,
    testName: r.test_name,
    date: r.date,
    scores: JSON.parse(r.scores_json),
    headlineLabel: r.headline_label,
    headlineScore: r.headline_score,
    band: r.band,
    attentionPassed: r.attention_passed === null ? null : !!r.attention_passed,
  }));
}

module.exports = { insertSubmission, getAllSubmissions, hasSubmission };
