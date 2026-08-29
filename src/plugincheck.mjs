export function parseCtrf(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(
      'Plugin Check output is not valid JSON. Use --format=ctrf; ' +
      '--format=json emits "FILE:" header lines and cannot be parsed. ' +
      `(${e.message})`,
    );
  }

  if (doc === null || typeof doc !== 'object' || doc.reportFormat !== 'CTRF') {
    throw new Error('Plugin Check output is not a CTRF report.');
  }

  const tests = doc.results?.tests ?? [];
  return tests.map((t) => ({
    code: t.extra?.code ?? null,
    findingType: t.extra?.findingType ?? t.rawStatus ?? null,
    severity: t.extra?.severity ?? null,
    filePath: t.filePath ?? null,
    line: t.line ?? 0,
    message: t.message ?? '',
    docs: t.extra?.docs ? t.extra.docs : null,
  }));
}

export function errorsOnly(findings) {
  return findings.filter((f) => f.findingType === 'ERROR');
}

export function baselineKey(slug, finding) {
  return `${slug}::${finding.code}::${finding.filePath}`;
}

export function diffAgainstBaseline(slug, findings, baseline) {
  const known = new Set(baseline?.[slug] ?? []);
  return findings.filter((f) => !known.has(baselineKey(slug, f)));
}

export function buildBaseline(perPlugin) {
  const out = {};
  for (const [slug, findings] of Object.entries(perPlugin)) {
    out[slug] = [...new Set(findings.map((f) => baselineKey(slug, f)))].sort();
  }
  return out;
}
