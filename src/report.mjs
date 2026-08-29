export function renderMarkdown(report) {
  const lines = [];

  lines.push(`# WordPress compatibility report`);
  lines.push('');
  lines.push(`**WordPress ${report.wpVersion}** · **PHP ${report.phpVersion}**`);
  lines.push(`Started ${report.startedAt} · finished ${report.finishedAt}`);
  lines.push('');

  lines.push('| Plugin | Status | Blocking | Advisory | New Plugin Check errors |');
  lines.push('|---|---|---|---|---|');
  for (const p of report.plugins) {
    const status = p.runError ? '⚠️ run error' : p.bumpEligible ? '✅ eligible' : '❌ blocked';
    const safeSlug = codeSpan(p.slug);
    const slugCell = safeSlug ? `\`${safeSlug}\`` : '';
    lines.push(
      `| ${slugCell} | ${status} | ${p.blocking.length} | ${p.advisory.length} | ` +
      `${p.pluginCheck.available ? p.pluginCheck.newErrors.length : 'n/a'} |`,
    );
  }
  lines.push('');

  for (const p of report.plugins) {
    lines.push(`## ${p.slug}`);
    lines.push('');
    if (p.sha) lines.push(`Tested at commit \`${p.sha.slice(0, 7)}\`${p.branch ? ` on \`${p.branch}\`` : ''}.`);

    if (p.runError) {
      lines.push('');
      lines.push(`> ⚠️ **Run error — this plugin was not tested.**`);
      lines.push('>');
      lines.push(`> ${p.runError}`);
      lines.push('');
      continue;
    }

    lines.push('');
    lines.push(renderFindings('Blocking', p.blocking));
    lines.push(renderFindings('Advisory', p.advisory));

    const failedSmoke = p.smoke.filter((s) => !s.ok);
    if (failedSmoke.length) {
      lines.push('### Failed smoke checks');
      lines.push('');
      for (const s of failedSmoke) lines.push(`- \`${s.url}\` — ${s.reason}`);
      lines.push('');
    }

    lines.push('### Plugin Check');
    lines.push('');
    if (!p.pluginCheck.available) {
      lines.push('_Plugin Check did not run for this plugin._');
    } else if (!p.pluginCheck.newErrors.length) {
      lines.push('_No new errors._');
    } else {
      for (const f of p.pluginCheck.newErrors) {
        const docs = f.docs ? ` ([docs](${f.docs}))` : '';
        const safeCode = codeSpan(f.code);
        const safeMessage = safeText(f.message);
        const location = formatLocation(f.filePath, f.line);
        const locationPart = location ? ` — \`${location}\`` : '';
        const codePart = safeCode ? `\`${safeCode}\` — ` : '';
        lines.push(`- ${codePart}${safeMessage}${locationPart}${docs}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

function safeText(value) {
  if (value == null || typeof value !== 'string') return '';
  return value.replace(/\n/g, ' ').replace(/[`|]/g, '\\$&');
}

function codeSpan(value) {
  if (value == null || typeof value !== 'string') return '';
  const trimmed = value
    .replace(/\n/g, ' ')
    .replace(/`/g, "'")
    .replace(/\|/g, '\\|');
  return trimmed;
}

function formatLocation(filePath, line) {
  const safePath = codeSpan(filePath);
  if (!safePath) return '';
  return `${safePath}${line ? `:${line}` : ''}`;
}

function renderFindings(title, findings) {
  if (!findings.length) return `### ${title}\n\n_None._\n`;

  const out = [`### ${title}`, ''];
  for (const f of findings) {
    const location = formatLocation(f.file, f.line);
    const where = location ? ` — \`${location}\`` : '';
    const attribution = f.attribution === 'indirect'
      ? ' _(indirect — the file path is not this plugin\'s; attributed because it was the only plugin active)_'
      : '';
    const safeMessage = safeText(f.message);
    out.push(`- **${f.kind}** ${safeMessage}${where}${attribution}`);
  }
  out.push('');
  return out.join('\n');
}
