const HEADER_RE = /^\[(\d{1,2}-[A-Za-z]{3}-\d{4}[^\]]*)\]\s+(?:PHP\s+([A-Za-z][A-Za-z ]*?):\s+)?(.*)$/;
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
  let location = LOCATION_RE.exec(entry.message);
  let locationInHeader = !!location;

  // If no location found in header message, scan continuation lines for the last matching line
  if (!location) {
    for (let i = entry.rawLines.length - 1; i >= 0; i--) {
      const match = LOCATION_RE.exec(entry.rawLines[i]);
      if (match) {
        location = match;
        break;
      }
    }
  }

  return {
    timestamp: entry.timestamp,
    level: entry.level,
    message: locationInHeader ? entry.message.slice(0, location.index).trim() : entry.message.trim(),
    file: location ? location[1] : null,
    line: location ? Number(location[2]) : null,
    raw: entry.rawLines.join('\n').replace(/\s+$/, ''),
  };
}
