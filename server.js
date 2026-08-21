require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const backup = require('./backup');
const TESTS = require('./tests.json');

const app = express();
const PORT = process.env.PORT || 3000;
const PERSONALITY_DIMS = ['C', 'ES', 'Ex', 'Ag', 'Op'];

app.set('trust proxy', 1);

app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 8 * 60 * 60 * 1000,
    },
  })
);

app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

function bandFor(score) {
  if (score >= 70) return 'Strong Signal';
  if (score >= 45) return 'Mixed Signal';
  return 'Limited Signal';
}

// Scores a submission against a given test's item bank. Three item shapes:
// - likert (personality, specialty tests don't use this) — normalized 0-100 with reverse-keying
// - mc (situational judgment scenarios) — summed option points, normalized 0-100
// - forced_choice (trait comparison quads) — each option is tagged with a facet;
//   picking it as "most" scores +1 for that facet, "least" scores -1, blended across
//   all quads a facet appears in, normalized 0-100 per facet, then averaged into CT/EQ.
const CT_FACETS = ['VERIFY', 'PLAN', 'PRIORITIZE', 'ROOTCAUSE'];
const EQ_FACETS = ['REGULATE', 'EMPATHY', 'TACT', 'NONDEFENSIVE'];

function scoreSubmission(testId, testDef, responses) {
  const items = testDef.items;
  const categories = {};
  items.forEach((item) => {
    if (item.type === 'forced_choice') return; // scored separately below
    if (!categories[item.category]) categories[item.category] = [];
    categories[item.category].push(item);
  });

  const scores = {};

  Object.keys(categories).forEach((cat) => {
    if (cat === 'ATT') return; // handled separately, not a reported score
    const catItems = categories[cat];
    if (catItems[0].type === 'likert') {
      let sum = 0;
      catItems.forEach((i) => {
        const raw = responses[i.id];
        sum += i.dir === 'R' ? 6 - raw : raw;
      });
      const min = catItems.length * 1;
      const max = catItems.length * 5;
      scores[cat] = Math.round(((sum - min) / (max - min)) * 100);
    } else if (catItems[0].type === 'mc') {
      let sum = 0;
      let maxPossible = 0;
      catItems.forEach((i) => {
        const chosenId = responses[i.id];
        const opt = i.options.find((o) => o.id === chosenId);
        const maxPts = Math.max(...i.options.map((o) => o.points));
        sum += opt ? opt.points : 0;
        maxPossible += maxPts;
      });
      scores[cat] = maxPossible > 0 ? Math.round((sum / maxPossible) * 100) : 0;
    }
  });

  // Forced-choice quads: tally each facet's most/least tally, normalize, then
  // average the 4 CT facets and 4 EQ facets into a single trait-comparison score each.
  const fcItems = items.filter((i) => i.type === 'forced_choice');
  if (fcItems.length) {
    const facetTotals = {};
    fcItems.forEach((item) => {
      const resp = responses[item.id] || {};
      item.options.forEach((opt) => {
        if (!facetTotals[opt.facet]) facetTotals[opt.facet] = { sum: 0, count: 0 };
        facetTotals[opt.facet].count += 1;
        if (resp.most === opt.id) facetTotals[opt.facet].sum += 1;
        else if (resp.least === opt.id) facetTotals[opt.facet].sum -= 1;
      });
    });
    const facetScores = {};
    Object.keys(facetTotals).forEach((f) => {
      const { sum, count } = facetTotals[f];
      facetScores[f] = count > 0 ? Math.round(((sum + count) / (2 * count)) * 100) : 50;
    });
    const ctVals = CT_FACETS.map((f) => facetScores[f]).filter((v) => v !== undefined);
    const eqVals = EQ_FACETS.map((f) => facetScores[f]).filter((v) => v !== undefined);
    if (ctVals.length) scores.CT_Trait = Math.round(ctVals.reduce((a, b) => a + b, 0) / ctVals.length);
    if (eqVals.length) scores.EQ_Trait = Math.round(eqVals.reduce((a, b) => a + b, 0) / eqVals.length);
  }

  // Blend the two CT signals (scenario judgment + trait comparison) into one CT score,
  // same for EQ — measuring the same construct two different ways is more resistant
  // to gaming either format alone, and more informative than either on its own.
  if (scores.CT_SCEN !== undefined) scores.CT_Scenario = scores.CT_SCEN;
  if (scores.EQ_SCEN !== undefined) scores.EQ_Scenario = scores.EQ_SCEN;
  delete scores.CT_SCEN;
  delete scores.EQ_SCEN;
  const ctParts = [scores.CT_Scenario, scores.CT_Trait].filter((v) => v !== undefined);
  const eqParts = [scores.EQ_Scenario, scores.EQ_Trait].filter((v) => v !== undefined);
  if (ctParts.length) scores.CT = Math.round(ctParts.reduce((a, b) => a + b, 0) / ctParts.length);
  if (eqParts.length) scores.EQ = Math.round(eqParts.reduce((a, b) => a + b, 0) / eqParts.length);

  let attentionPassed = null;
  const attItem = items.find((i) => i.category === 'ATT');
  if (attItem) {
    const raw = responses[attItem.id];
    attentionPassed = raw === 4 || raw === 5;
  }

  // Headline metric differs by test.
  let headlineLabel, headlineScore;
  if (testId === 'general') {
    const parts = [scores.CT, scores.EQ].filter((v) => v !== undefined);
    const combined = parts.length ? Math.round(parts.reduce((a, b) => a + b, 0) / parts.length) : 0;
    headlineLabel = 'Critical Thinking & EQ Indicator';
    headlineScore = combined;
  } else {
    headlineLabel = `${testDef.name} — Judgment Score`;
    headlineScore = scores.SCENARIO || 0;
  }

  return { scores, headlineLabel, headlineScore, band: bandFor(headlineScore), attentionPassed };
}

// ---- Public: list available tests ----
app.get('/api/tests', (req, res) => {
  const list = Object.entries(TESTS).map(([id, t]) => ({
    id,
    name: t.name,
    description: t.description,
    itemCount: t.items.length,
  }));
  res.json(list);
});

// ---- Public: item bank for one test (scoring keys stripped) ----
app.get('/api/items', (req, res) => {
  const testId = req.query.test;
  const testDef = TESTS[testId];
  if (!testDef) return res.status(400).json({ error: 'Unknown test.' });

  const items = testDef.items.map((i) => {
    const base = { id: i.id, type: i.type, text: i.text };
    if (i.type === 'mc' || i.type === 'forced_choice') {
      base.options = i.options.map((o) => ({ id: o.id, text: o.text }));
    }
    return base;
  });
  res.json({ testId, testName: testDef.name, items });
});

// ---- Public: check whether a name/ID already submitted a given test ----
app.get('/api/check-applicant', (req, res) => {
  const { name, test } = req.query;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'A name or ID is required.' });
  }
  if (!TESTS[test]) return res.status(400).json({ error: 'Unknown test.' });
  res.json({ alreadySubmitted: db.hasSubmission(name, test) });
});

// ---- Public: submit an assessment ----
app.post('/api/submit', (req, res) => {
  try {
    const { applicantId, testId, responses } = req.body || {};

    if (!applicantId || typeof applicantId !== 'string' || !applicantId.trim()) {
      return res.status(400).json({ error: 'Applicant name/ID is required.' });
    }
    const testDef = TESTS[testId];
    if (!testDef) {
      return res.status(400).json({ error: 'Unknown test.' });
    }
    if (!responses || typeof responses !== 'object') {
      return res.status(400).json({ error: 'Responses are required.' });
    }
    if (db.hasSubmission(applicantId, testId)) {
      return res.status(409).json({
        error: 'An assessment has already been submitted under this name or ID for this test. If this is a mistake, please contact staff.',
      });
    }
    for (const item of testDef.items) {
      const val = responses[item.id];
      if (item.type === 'likert') {
        if (![1, 2, 3, 4, 5].includes(val)) {
          return res.status(400).json({ error: `Missing or invalid response for item ${item.id}.` });
        }
      } else if (item.type === 'mc') {
        if (!item.options.some((o) => o.id === val)) {
          return res.status(400).json({ error: `Missing or invalid response for item ${item.id}.` });
        }
      } else if (item.type === 'forced_choice') {
        if (
          !val ||
          typeof val !== 'object' ||
          !item.options.some((o) => o.id === val.most) ||
          !item.options.some((o) => o.id === val.least) ||
          val.most === val.least
        ) {
          return res.status(400).json({ error: `Missing or invalid response for item ${item.id}.` });
        }
      }
    }

    const scored = scoreSubmission(testId, testDef, responses);
    const record = {
      applicant: applicantId.trim(),
      testId,
      testName: testDef.name,
      date: new Date().toISOString(),
      ...scored,
    };

    db.insertSubmission(record);
    // The applicant never sees their own scores — only that submission succeeded.
    res.json({ ok: true });
  } catch (err) {
    console.error('Error in /api/submit:', err);
    res.status(500).json({ error: 'Something went wrong recording this submission. Please try again, and let staff know if it keeps happening.' });
  }
});

// ---- Staff auth ----
app.post('/api/login', async (req, res) => {
  const { password } = req.body || {};
  const hashes = [process.env.STAFF_PASSWORD_HASH_1, process.env.STAFF_PASSWORD_HASH_2].filter(Boolean);
  if (!hashes.length) {
    return res.status(500).json({ error: 'Server is not configured with a staff password yet.' });
  }
  let ok = false;
  for (const hash of hashes) {
    if (await bcrypt.compare(password || '', hash)) { ok = true; break; }
  }
  if (!ok) return res.status(401).json({ error: 'Incorrect password.' });
  req.session.authenticated = true;
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/session', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

// ---- Protected: results ----
app.get('/api/results', requireAuth, (req, res) => {
  res.json(db.getAllSubmissions());
});

app.get('/api/results/csv', requireAuth, (req, res) => {
  const rows = db.getAllSubmissions();
  const header = ['Applicant', 'Test', 'Date', 'Scores', 'HeadlineLabel', 'HeadlineScore', 'Band', 'AttentionCheckPassed'];
  const csvRows = rows.map((r) => [
    r.applicant,
    r.testName,
    r.date,
    JSON.stringify(r.scores),
    r.headlineLabel,
    r.headlineScore,
    r.band,
    r.attentionPassed === null ? 'n/a' : r.attentionPassed,
  ]);
  const csv = [header, ...csvRows]
    .map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="cess_fit_assessment_results.csv"');
  res.send(csv);
});

// ---- Protected: backups ----
app.get('/api/backups', requireAuth, (req, res) => {
  res.json(backup.listBackups());
});

app.get('/api/backups/:filename', requireAuth, (req, res) => {
  const full = backup.backupFilePath(req.params.filename);
  if (!full) return res.status(404).json({ error: 'Backup not found.' });
  res.download(full);
});

app.get('/api/backup/download', requireAuth, (req, res) => {
  if (!fs.existsSync(backup.DB_PATH)) {
    return res.status(404).json({ error: 'No database file yet.' });
  }
  res.download(backup.DB_PATH, `cess-fit-assessment-backup-${new Date().toISOString().slice(0, 10)}.sqlite`);
});

app.post('/api/backups/run', requireAuth, (req, res) => {
  const dest = backup.runBackup();
  if (!dest) return res.status(404).json({ error: 'No database file yet.' });
  res.json({ ok: true, file: path.basename(dest) });
});

app.listen(PORT, () => {
  console.log(`CESS Fit Assessment running on port ${PORT}`);
  backup.runBackup();
  setInterval(() => backup.runBackup(), 24 * 60 * 60 * 1000);
});

// Catch-all: any unhandled error in any route returns JSON, not an HTML error page,
// so the client never shows a misleading "could not reach the server" message.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Unexpected server error. Please try again.' });
});
