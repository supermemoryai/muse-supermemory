// Preload for tests that run hook scripts in a child process: no request may
// leave the machine and no browser may open.
const childProcess = require('node:child_process');

globalThis.fetch = async (url) => {
  throw new Error(`network disabled in tests: ${url}`);
};

childProcess.execFile = (command, args, options, callback) => {
  const done = typeof options === 'function' ? options : callback;
  process.stderr.write(`browser launch disabled: ${command}\n`);
  if (done) done(new Error('browser launch disabled in tests'));
};
