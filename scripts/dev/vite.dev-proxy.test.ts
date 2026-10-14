import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The dev server must forward every route family the web app talks to: a
// missing prefix falls back to the SPA shell (200 text/html) and reads as a
// broken API in the browser. `monitor-proxy` is gone from the server, so a
// lingering prefix would be dead config.
const source = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf8');

describe('vite dev proxy routes', () => {
  it('forwards the api, v1 and gemini route families to the backend', () => {
    for (const prefix of ['/api', '/v1', '/v1beta']) {
      expect(source).toContain(`'^${prefix}($|/)'`);
    }
  });

  it('keeps no prefix the server does not register', () => {
    expect(source).not.toContain('monitor-proxy');
  });
});
