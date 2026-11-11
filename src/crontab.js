const { execFileSync } = require('child_process');

function normalizeCrontab(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n*$/, '\n');
}

function splitLines(text) {
  const lines = normalizeCrontab(text).split('\n');
  lines.pop();
  return lines.length === 1 && lines[0] === '' ? [] : lines;
}

function indexesOf(lines, marker) {
  return lines.reduce((found, line, index) => (line.trim() === marker ? [...found, index] : found), []);
}

function isEntryLine(line) {
  const trimmed = line.trim();
  return trimmed !== '' && !trimmed.startsWith('#');
}

function locatePair(lines, start, end, owner, { required }) {
  const starts = indexesOf(lines, start);
  const ends = indexesOf(lines, end);
  if (starts.length > 1 || ends.length > 1) {
    throw new Error(`duplicate ${owner} markers (${start}) found; refusing to alter crontab`);
  }
  if (starts.length !== ends.length) {
    throw new Error(`${owner} start and end markers (${start}) do not pair; refusing to alter crontab`);
  }
  if (starts.length === 0) {
    if (required) throw new Error(`${owner} matched no block (${start} ... ${end}); refusing to alter crontab`);
    return null;
  }
  if (ends[0] <= starts[0]) throw new Error(`${end} appears before ${start}; refusing to alter crontab`);
  return { owner, start: starts[0], end: ends[0] };
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

function insideAny(index, ranges) {
  return ranges.some((range) => index >= range.start && index <= range.end);
}

/**
 * Pure: returns `currentText` with `block` ({ start, end, lines }) in place of its own marked pair, the
 * `replacements.blocks` pairs and the `replacements.lines` entries, at the first removed item's position.
 * Duplicate, unpaired, nested or overlapping markers, and any replacement that does not match exactly one, throw.
 */
function replaceCrontabBlock(currentText, block, replacements = {}) {
  const lines = splitLines(currentText);
  const replaceBlocks = replacements.blocks || [];
  const replaceLines = replacements.lines || [];

  const own = locatePair(lines, block.start, block.end, block.start, { required: false });
  const removedBlocks = replaceBlocks.map((marker) =>
    locatePair(lines, marker.start, marker.end, `--replace-block ${marker.start}`, { required: true }),
  );
  const blockRanges = [...(own ? [own] : []), ...removedBlocks];
  assertNoOverlap(blockRanges);

  if (own) {
    const nested = lines.findIndex(
      (line, index) =>
        index > own.start && index < own.end && /^#\s*\/?db-backup:/.test(line.trim()),
    );
    if (nested !== -1) {
      throw new Error(`${block.start} block contains another db-backup marker (${lines[nested].trim()}); refusing to alter crontab`);
    }
  }

  const removedLineIndexes = replaceLines.map((substring) => {
    const matches = lines.flatMap((line, index) =>
      isEntryLine(line) && !insideAny(index, blockRanges) && line.includes(substring) ? [index] : [],
    );
    if (matches.length !== 1) {
      throw new Error(
        `--replace-line ${JSON.stringify(substring)} matched ${matches.length} crontab entry lines, expected exactly 1; refusing to alter crontab`,
      );
    }
    return matches[0];
  });
  if (new Set(removedLineIndexes).size !== removedLineIndexes.length) {
    throw new Error('two --replace-line values matched the same crontab line; refusing to alter crontab');
  }

  const removedRanges = [
    ...blockRanges,
    ...removedLineIndexes.map((index) => ({ start: index, end: index })),
  ];
  const rendered = [block.start, ...block.lines, block.end];
  if (removedRanges.length === 0) {
    const prefix = lines.length > 0 && lines.at(-1) !== '' ? [...lines, ''] : lines;
    return normalizeCrontab([...prefix, ...rendered].join('\n'));
  }

  const firstRemoved = Math.min(...removedRanges.map((range) => range.start));
  const output = [];
  lines.forEach((line, index) => {
    if (index === firstRemoved) output.push(...rendered);
    if (!insideAny(index, removedRanges)) output.push(line);
  });
  return normalizeCrontab(output.join('\n'));
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

function readCrontab(run = execFileSync) {
  try {
    return String(run('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
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
  replaceCrontabBlock,
  crontabDiff,
  findTimezoneLines,
  readCrontab,
  writeCrontab,
};
