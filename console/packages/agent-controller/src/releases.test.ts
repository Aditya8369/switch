import { describe, expect, it } from 'vitest';
import { throughCurrent } from './releases';

describe.skipIf(process.platform === 'win32')('throughCurrent', () => {
  it('reaches a file of the release through current, and leaves one outside it alone', () => {
    expect(
      throughCurrent(
        '/data/releases',
        '/home/me/.local',
        '/home/me/.local/lib/node_modules/switch-agent-controller/dist/cli.js'
      )
    ).toBe('/data/releases/current/lib/node_modules/switch-agent-controller/dist/cli.js');
    expect(throughCurrent('/data/releases', '/home/me/.local', '/opt/shared-host.mjs')).toBe(
      '/opt/shared-host.mjs'
    );
    expect(throughCurrent('/data/releases', '/home/me/.local', '/home/me/.localother/x')).toBe(
      '/home/me/.localother/x'
    );
  });
});
