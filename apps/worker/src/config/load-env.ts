import { resolve } from 'node:path';

import dotenv from 'dotenv';

export function loadRootEnvironment(): void {
  dotenv.config({ path: resolve(process.cwd(), '../../.env'), quiet: true });
}
