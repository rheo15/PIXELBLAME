import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

export function tmpStore(): Store {
  return new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'pixelblame-test-')));
}
