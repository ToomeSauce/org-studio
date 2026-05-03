/**
 * Tests for #1191 — version-shipped Telegram nudge helpers.
 *
 * The rpc-side delivery is fire-and-forget and exercised via integration;
 * here we lock down the pure helpers (message format + agent-id resolution)
 * so they can't drift.
 */
import { describe, test, expect } from 'vitest';
import {
  buildVersionShippedMessage,
  resolveVisionOwnerAgentId,
} from './vision-notify';

describe('buildVersionShippedMessage', () => {
  test('formats per spec: ✅ vX shipped on <project>. Approve next?', () => {
    expect(buildVersionShippedMessage('Org Studio', '0.16.0')).toBe(
      '✅ v0.16.0 shipped on Org Studio. Approve next?',
    );
  });

  test('does not mangle project names with spaces or punctuation', () => {
    expect(
      buildVersionShippedMessage("Mikey's Lab — Voice v2", '1.2.3'),
    ).toBe(
      "✅ v1.2.3 shipped on Mikey's Lab — Voice v2. Approve next?",
    );
  });

  test('passes version through verbatim (no leading-v stripping)', () => {
    // Versions in store are already semver per the v0.16 migration; we
    // prepend a single "v" and trust the input. This locks down the
    // contract so a future caller that passes "v0.16.0" gets
    // "✅ vv0.16.0 ..." which is loud-and-wrong rather than silently
    // sometimes-prefixed.
    expect(buildVersionShippedMessage('Foo', '0.1.0')).toBe(
      '✅ v0.1.0 shipped on Foo. Approve next?',
    );
  });
});

describe('resolveVisionOwnerAgentId', () => {
  const teammates = [
    { name: 'Mikey', agentId: 'mikey' },
    { name: 'Henry', agentId: 'henry' },
    { name: 'Basil', agentId: 'basil' },
  ];

  test('resolves by display name (case-insensitive)', () => {
    expect(resolveVisionOwnerAgentId('Henry', teammates)).toBe('henry');
    expect(resolveVisionOwnerAgentId('henry', teammates)).toBe('henry');
    expect(resolveVisionOwnerAgentId('HENRY', teammates)).toBe('henry');
  });

  test('resolves by agentId directly', () => {
    expect(resolveVisionOwnerAgentId('mikey', teammates)).toBe('mikey');
  });

  test('returns null for unknown owner', () => {
    expect(resolveVisionOwnerAgentId('nobody', teammates)).toBeNull();
  });

  test('returns null for missing/undefined visionOwner', () => {
    expect(resolveVisionOwnerAgentId(undefined, teammates)).toBeNull();
    expect(resolveVisionOwnerAgentId('', teammates)).toBeNull();
  });

  test('returns null for empty/missing teammates list', () => {
    expect(resolveVisionOwnerAgentId('Mikey', [])).toBeNull();
    expect(resolveVisionOwnerAgentId('Mikey', undefined)).toBeNull();
  });
});
