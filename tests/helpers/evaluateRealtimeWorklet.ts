import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

const workletPath = resolve(process.cwd(), 'public/worklets/looper-processor.js');
const stretchPath = resolve(process.cwd(), 'public/worklets/time-stretch-core.js');

const stretchModuleSource = readFileSync(stretchPath, 'utf8')
  .replace(/\bexport\s+(?=(?:function|const|class)\b)/g, '');
const stretchSource = `(() => {
${stretchModuleSource}
globalThis.__webrcTimeStretchCore = { TIME_STRETCH_WINDOW_FRAMES, TIME_STRETCH_HOP_FRAMES, createTimeStretchState, resetTimeStretchState, processTimeStretchFrame, prepareTimeStretchHop };
})();`;
const workletSource = readFileSync(workletPath, 'utf8')
  .replace(/^import\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"];?\s*/m, '');

export function evaluateRealtimeWorklet(scope: Record<string, unknown>): void {
  runInNewContext(stretchSource, scope);
  const core = scope.__webrcTimeStretchCore as Record<string, unknown> | undefined;
  if (!core) throw new Error('The actual shared time-stretch module did not evaluate.');
  Object.assign(scope, core);
  runInNewContext(workletSource, scope);
}

export const REALTIME_WORKLET_SOURCE_PATH = workletPath;
export const TIME_STRETCH_SOURCE_PATH = stretchPath;
