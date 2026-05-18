/**
 * #1386 Phase 2 — Tests for resolveAgentApiToken.
 *
 * Verifies the per-agent token preference + global fallback contract.
 * No mocks; pure function test against in-memory Teammate[] objects.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { resolveAgentApiToken, type Teammate } from './teammates';

const baseTeam: Teammate[] = [
  {
    id: 'henry', agentId: 'henry', name: 'Henry', emoji: '🪶',
    title: 'Chief of Staff', domain: 'coordination', description: '', color: 'cyan',
  },
  {
    id: 'mikey', agentId: 'mikey', name: 'Mikey', emoji: '🔬',
    title: 'Labs Dev', domain: 'labs', description: '', color: 'amber',
    agentToken: 'os_per_agent_mikey_xyz',
  },
  {
    id: 'ana', agentId: 'ana', name: 'Ana', emoji: '🌿',
    title: 'Platform Dev', domain: 'platform', description: '', color: 'emerald',
    agentToken: '   ', // whitespace-only — should NOT count as a token
  },
];

const origKey = process.env.ORG_STUDIO_API_KEY;

describe('#1386 resolveAgentApiToken', () => {
  beforeEach(() => {
    delete process.env.ORG_STUDIO_API_KEY;
  });
  afterEach(() => {
    if (origKey === undefined) delete process.env.ORG_STUDIO_API_KEY;
    else process.env.ORG_STUDIO_API_KEY = origKey;
  });

  test('returns per-agent token when teammate.agentToken is set', () => {
    process.env.ORG_STUDIO_API_KEY = 'global-key';
    expect(resolveAgentApiToken(baseTeam, 'mikey')).toBe('os_per_agent_mikey_xyz');
  });

  test('falls back to ORG_STUDIO_API_KEY when no per-agent token', () => {
    process.env.ORG_STUDIO_API_KEY = 'global-key';
    expect(resolveAgentApiToken(baseTeam, 'henry')).toBe('global-key');
  });

  test('whitespace-only agentToken is ignored, falls through to global', () => {
    process.env.ORG_STUDIO_API_KEY = 'global-key';
    expect(resolveAgentApiToken(baseTeam, 'ana')).toBe('global-key');
  });

  test('returns null when neither per-agent nor global key exists (dev mode)', () => {
    expect(resolveAgentApiToken(baseTeam, 'henry')).toBeNull();
  });

  test('returns per-agent token even when ORG_STUDIO_API_KEY is unset', () => {
    expect(resolveAgentApiToken(baseTeam, 'mikey')).toBe('os_per_agent_mikey_xyz');
  });

  test('unknown agentId falls through to global', () => {
    process.env.ORG_STUDIO_API_KEY = 'global-key';
    expect(resolveAgentApiToken(baseTeam, 'nobody')).toBe('global-key');
  });

  test('matches by id when agentId field is empty', () => {
    const team: Teammate[] = [{
      id: 'sam', agentId: '', name: 'Sam', emoji: '⚖️',
      title: 'Legal', domain: 'legal', description: '', color: 'purple',
      agentToken: 'os_sam_token',
    }];
    expect(resolveAgentApiToken(team, 'sam')).toBe('os_sam_token');
  });
});
