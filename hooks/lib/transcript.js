const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { atomicWriteJson, getSessionDir, readJson } = require('./session-state');

const CURSOR_FILE = 'cursor.json';
const HEAD_BYTES = 4096;

function readCursor(file) {
  const cursor = readJson(file, null);
  if (
    Number.isInteger(cursor?.offset) &&
    Number.isInteger(cursor?.generation) &&
    typeof cursor?.headHash === 'string'
  ) {
    return cursor;
  }
  return { offset: 0, generation: 0, headHash: '' };
}

function hashPrefix(fd, length) {
  if (length <= 0) return '';
  const buffer = Buffer.alloc(length);
  fs.readSync(fd, buffer, 0, length, 0);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function readRawDelta(transcriptPath, sessionId) {
  const sessionDir = getSessionDir(sessionId);
  if (!sessionDir || !transcriptPath || !fs.existsSync(transcriptPath)) return null;
  const cursorFile = path.join(sessionDir, CURSOR_FILE);
  const previous = readCursor(cursorFile);
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let { offset, generation } = previous;
    if (
      size < offset ||
      previous.headHash !== hashPrefix(fd, Math.min(HEAD_BYTES, offset))
    ) {
      offset = 0;
      generation += 1;
    }
    if (size <= offset) return null;

    const buffer = Buffer.alloc(size - offset);
    fs.readSync(fd, buffer, 0, buffer.length, offset);
    const end = buffer.lastIndexOf(0x0a) + 1;
    if (end === 0) return null;

    const nextOffset = offset + end;
    const headHash = hashPrefix(fd, Math.min(HEAD_BYTES, nextOffset));
    return {
      raw: buffer.subarray(0, end).toString('utf8'),
      generation,
      offset,
      commit: () =>
        atomicWriteJson(cursorFile, { offset: nextOffset, generation, headHash }),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function resolveTranscriptPath(input) {
  if (typeof input.transcript_path === 'string' && input.transcript_path) {
    return input.transcript_path;
  }
  const sessionId = input.session_id;
  if (!sessionId) return null;
  const root = path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
    'muse',
    'sessions',
  );
  if (!fs.existsSync(root)) return null;
  try {
    const matches = [];
    const walk = (dir, depth) => {
      if (depth > 5) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const next = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === sessionId) {
            const log = path.join(next, 'session.jsonl');
            if (fs.existsSync(log)) matches.push(log);
          }
          walk(next, depth + 1);
        }
      }
    };
    walk(root, 0);
    return matches.sort().at(-1) || null;
  } catch {
    return null;
  }
}

module.exports = {
  readRawDelta,
  resolveTranscriptPath,
};
