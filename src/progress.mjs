import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';

const clean = text => String(text).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');

export function createProgress({ fresh = false, stream = process.stderr } = {}) {
  const interactive = Boolean(stream.isTTY && process.env.TERM !== 'dumb');
  let finished = false;
  if (!interactive) return {
    step: message => stream.write(`[sprites] ${clean(message)}\n`),
    finish: (message, failed = false) => {
      if (finished) return false;
      finished = true;
      stream.write(`[sprites] ${failed ? 'Error: ' : ''}${clean(message)}\n`);
      return true;
    },
  };
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(new URL(import.meta.url), {
    execArgv: process.execArgv.filter(arg => !arg.startsWith('--input-type')),
    workerData: { fresh, signal: signal.buffer, width: stream.columns || 80, color: !Object.hasOwn(process.env, 'NO_COLOR') },
  });
  worker.unref();
  return {
    step: message => { if (!finished) worker.postMessage({ message: clean(message) }); },
    finish: (message, failed = false) => {
      if (finished) return false;
      finished = true;
      worker.postMessage({ message: clean(message), finish: true, failed });
      // Finish all terminal writes before the remote CLI takes ownership of the TTY.
      Atomics.wait(signal, 0, 0, 5000);
      void worker.terminate();
      return true;
    },
  };
}

if (!isMainThread && workerData?.signal) {
  const signal = new Int32Array(workerData.signal);
  const write = text => fs.writeSync(2, text);
  const paint = (code, text) => workerData.color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let current, started, frame = 0;
  const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
  const line = (symbol, message, time = '') => {
    const available = Math.max(8, workerData.width - time.length - 9);
    const text = message.length > available ? message.slice(0, available - 1) + '…' : message;
    return `  ${symbol} ${text}${time ? '  ' + paint('2', time) : ''}`;
  };
  // Only a newly created setup pane has its launch echo and scrollback removed.
  if (workerData.fresh) write('\x1b[2J\x1b[3J\x1b[H');
  write(`\n  ${paint('1;35', '✦  sprites')} ${paint('2', '/ remote workspace')}\n\n`);
  const tick = () => { if (current) write('\r\x1b[2K' + line(paint('35', frames[frame++ % frames.length]), current, elapsed())); };
  const timer = setInterval(tick, 90);
  parentPort.on('message', event => {
    if (current) write('\r\x1b[2K' + line(paint(event.failed ? '31' : '32', event.failed ? '✗' : '✓'), current, elapsed()) + '\n');
    if (event.finish) {
      clearInterval(timer);
      write(`\n  ${paint(event.failed ? '31' : '32', event.failed ? '✗' : '→')} ${event.message}\n\n`);
      Atomics.store(signal, 0, 1); Atomics.notify(signal, 0);
      parentPort.close();
    } else { current = event.message; started = Date.now(); tick(); }
  });
}
