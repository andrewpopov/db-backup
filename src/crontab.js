const { execFileSync } = require('child_process');

const ENV_LINE = /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/;

function normalizeCrontab(text) {
  return String(text || '').replace(/\n*$/, '\n');
}

function splitLines(text) {
  const lines = normalizeCrontab(text).split('\n');
  lines.pop();
  return lines.length === 1 && lines[0] === '' ? [] : lines;
}

function indexesOf(lines, marker) {
  return lines.reduce((found, line, index) => (line.trim() === marker ? [...found, index] : found), []);
}

function isReplaceableLine(line) {
  const trimmed = line.trim();
  return trimmed !== '' && !trimmed.startsWith('#') && !ENV_LINE.test(trimmed);
}

function markerText(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('#') ? trimmed.slice(1).trim() : null;
}

function locatePair(lines, start, end, owner) {
  const starts = indexesOf(lines, start);
  const ends = indexesOf(lines, end);
  if (starts.length > 1 || ends.length > 1) {
    throw new Error(`duplicate ${owner} markers (${start}) found; refusing to alter crontab`);
  }
  if (starts.length !== ends.length) {
    throw new Error(`${owner} start and end markers (${start}) do not pair; refusing to alter crontab`);
  }
  if (starts.length === 0) return null;
  if (ends[0] <= starts[0]) throw new Error(`${end} appears before ${start}; refusing to alter crontab`);
  return { owner, start: starts[0], end: ends[0] };
}

function markedRanges(lines) {
  const ranges = [];
  lines.forEach((line, end) => {
    const text = markerText(line);
    if (!text || !text.startsWith('/') || text.length === 1) return;
    const name = text.slice(1).trim();
    for (let start = end - 1; start >= 0; start -= 1) {
      if (markerText(lines[start]) === name) {
        ranges.push({ owner: name, start, end });
        break;
      }
    }
  });
  return ranges;
}

function assertNoOverlap(ranges) {
  for (let left = 0; left < ranges.length; left += 1) {
    for (let right = left + 1; right < ranges.length; right += 1) {
      const a = ranges[left];
      const b = ranges[right];
      if (a.start <= b.end && b.start <= a.end) {
        throw new Error(`${a.owner} and ${b.owner} overlap or nest; refusing to alter crontab`);
      }
    }
  }
}

function insideRange(index, range) {
  return index >= range.start && index <= range.end;
}

function insideAny(index, ranges) {
  return ranges.some((range) => insideRange(index, range));
}

function locateReplacedLine(lines, substring, ranges, replacedRanges, ownBlockPresent, warnings) {
  const matches = lines.flatMap((line, index) =>
    isReplaceableLine(line) && line.includes(substring) && !insideAny(index, replacedRanges) ? [index] : [],
  );
  const flag = `--replace-line ${JSON.stringify(substring)}`;
  for (const index of matches) {
    const enclosing = ranges.find((range) => insideRange(index, range));
    if (enclosing) throw new Error(`${flag} matches a line inside block ${enclosing.owner}; use a more distinctive substring; refusing to alter crontab`);
  }
  if (matches.length > 1) throw new Error(`${flag} matched ${matches.length} crontab entry lines, expected at most 1; refusing to alter crontab`);
  if (matches.length === 0) {
    if (!ownBlockPresent) throw new Error(`${flag} matched no crontab entry line and the schedule is not installed yet; check for a typo; refusing to alter crontab`);
    warnings.push(`${flag} matched no line (already migrated)`);
    return null;
  }
  return matches[0];
}

/**
 * Pure: `{ text, warnings }` for `currentText` with `block` ({ start, end, lines }) in place of its own marked
 * pair, the `replacements.blocks` pairs and the `replacements.lines` entries, at the first removed item's position.
 * A replacement matching nothing is a warning once the block is installed and an error before; matching more than one,
 * or a line inside any marked block other than its own or a replaced one, always throws, as do duplicate, unpaired, nested or overlapping markers.
 */
function planCrontabBlock(currentText, block, replacements = {}) {
  const lines = splitLines(currentText);
  const warnings = [];
  const own = locatePair(lines, block.start, block.end, block.start);

  const removedBlocks = (replacements.blocks || []).flatMap((marker) => {
    const range = locatePair(lines, marker.start, marker.end, `--replace-block ${marker.start}`);
    if (range) return [range];
    if (!own) throw new Error(`--replace-block ${marker.start} matched no block and the schedule is not installed yet; check for a typo; refusing to alter crontab`);
    warnings.push(`--replace-block ${marker.start} matched no block (already migrated)`);
    return [];
  });
  const blockRanges = [...(own ? [own] : []), ...removedBlocks];
  assertNoOverlap(blockRanges);

  if (own) {
    const nested = lines.findIndex(
      (line, index) => index > own.start && index < own.end && /^#\s*\/?db-backup:/.test(line.trim()),
    );
    if (nested !== -1) {
      throw new Error(`${block.start} block contains another db-backup marker (${lines[nested].trim()}); refusing to alter crontab`);
    }
  }

  const ranges = markedRanges(lines);
  const removedLineIndexes = (replacements.lines || []).flatMap((substring) => {
    const index = locateReplacedLine(lines, substring, ranges, blockRanges, Boolean(own), warnings);
    return index === null ? [] : [index];
  });
  if (new Set(removedLineIndexes).size !== removedLineIndexes.length) {
    throw new Error('two --replace-line values matched the same crontab line; refusing to alter crontab');
  }

  const removedRanges = [...blockRanges, ...removedLineIndexes.map((index) => ({ start: index, end: index }))];
  const rendered = [block.start, ...block.lines, block.end];
  if (removedRanges.length === 0) {
    const prefix = lines.length > 0 && lines.at(-1) !== '' ? [...lines, ''] : lines;
    return { text: normalizeCrontab([...prefix, ...rendered].join('\n')), warnings };
  }

  const firstRemoved = Math.min(...removedRanges.map((range) => range.start));
  const output = [];
  lines.forEach((line, index) => {
    if (index === firstRemoved) output.push(...rendered);
    if (!insideAny(index, removedRanges)) output.push(line);
  });
  return { text: normalizeCrontab(output.join('\n')), warnings };
}

function replaceCrontabBlock(currentText, block, replacements = {}) {
  return planCrontabBlock(currentText, block, replacements).text;
}

function crontabDiff(before, after, { context = 2 } = {}) {
  const left = splitLines(before);
  const right = splitLines(after);
  const lcs = Array.from({ length: left.length + 1 }, () => new Array(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      lcs[i][j] = left[i] === right[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      ops.push({ sign: ' ', text: left[i] });
      i += 1;
      j += 1;
    } else if (j < right.length && (i === left.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      ops.push({ sign: '+', text: right[j] });
      j += 1;
    } else {
      ops.push({ sign: '-', text: left[i] });
      i += 1;
    }
  }
  const changedAt = ops.flatMap((op, index) => (op.sign === ' ' ? [] : [index]));
  const visible = ops.map((_, index) => changedAt.some((changed) => Math.abs(changed - index) <= context));
  const out = [];
  ops.forEach((op, index) => {
    if (visible[index]) out.push(`${op.sign}${op.text}`);
    else if (index > 0 && visible[index - 1]) out.push('...');
  });
  return out.join('\n');
}

/** `TZ=`/`CRON_TZ=` assignments: Debian cron ignores them, so a schedule written against one runs at the wrong time. */
function findTimezoneLines(text) {
  return splitLines(text).filter((line) => /^\s*(CRON_TZ|TZ)\s*=/.test(line));
}

function assertNoEscapedControlCharacters(text) {
  if (text.split('\n').some((line) => line.endsWith('\\r') || line.includes('\\b'))) {
    throw new Error('crontab contains escaped control characters; fix by hand');
  }
}

function readCrontab(run = execFileSync) {
  try {
    const text = String(run('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    assertNoEscapedControlCharacters(text);
    return text;
  } catch (error) {
    const output = `${error.stdout || ''}\n${error.stderr || ''}`;
    if (error.status === 1 && /no crontab/i.test(output)) return '';
    throw error;
  }
}

function writeCrontab(content, run = execFileSync) {
  run('crontab', ['-'], { input: content, encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'] });
}

module.exports = {
  normalizeCrontab,
  planCrontabBlock,
  replaceCrontabBlock,
  crontabDiff,
  findTimezoneLines,
  readCrontab,
  writeCrontab,
};
