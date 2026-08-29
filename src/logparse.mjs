const HEADER_RE = /^\[([^\]]+)\]\s+(?:PHP\s+([A-Za-z][A-Za-z ]*?):\s+)?(.*)$/;
const LOCATION_RE = /\s+in\s+(\/\S.*?)\s+on line\s+(\d+)\s*$/;

export function parseDebugLog(text) {
  if (!text) return [];

  const entries = [];
  let current = null;

  for (const line of text.split('\n')) {
    const match = HEADER_RE.exec(line);
    if (match) {
      if (current) entries.push(finalize(current));
      current = {
        timestamp: match[1],
        level: match[2] ? match[2].trim() : 'Log',
        message: match[3],
        rawLines: [line],
      };
    } else if (current) {
      current.rawLines.push(line);
    }
  }

  if (current) entries.push(finalize(current));
  return entries;
}

function finalize(entry) {
  const location = LOCATION_RE.exec(entry.message);
  return {
    timestamp: entry.timestamp,
    level: entry.level,
    message: location ? entry.message.slice(0, location.index).trim() : entry.message.trim(),
    file: location ? location[1] : null,
    line: location ? Number(location[2]) : null,
    raw: entry.rawLines.join('\n').replace(/\s+$/, ''),
  };
}
