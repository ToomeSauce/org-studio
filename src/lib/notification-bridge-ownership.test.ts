import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(process.cwd());

describe('#1809 notification bridge ownership wiring', () => {
  it('gates the server.mjs comment LISTEN path before it calls the notification endpoint', () => {
    const source = readFileSync(resolve(root, 'server.mjs'), 'utf8');
    const commentBranch = source.slice(
      source.indexOf('// Process comments only on a runtime-connected bridge.'),
      source.indexOf('// #1513 — Legacy inline @mention dispatch removed.'),
    );

    expect(commentBranch).toContain('shouldRunNotificationListenBridge(process.env)');
    expect(commentBranch).toContain('/api/notify/comment');
  });

  it('also rejects direct endpoint calls on a non-owner process', () => {
    const source = readFileSync(resolve(root, 'src/app/api/notify/comment/route.ts'), 'utf8');
    const guard = source.indexOf('if (!shouldRunNotificationListenBridge(process.env))');
    const route = source.indexOf('routeCommentNotifications({');

    expect(guard).toBeGreaterThan(0);
    expect(route).toBeGreaterThan(guard);
    expect(source.slice(guard, route)).toContain("reason: 'runtime-bridge-not-owner'");
  });
});
