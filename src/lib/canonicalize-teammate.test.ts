import { describe, it, expect } from 'vitest';
import { canonicalizeTeammate } from './canonicalize-teammate';

const ROSTER = [
  { id: 'mikey', agentId: 'mikey', name: 'Mikey' },
  { id: 'ana', agentId: 'ana', name: 'Ana' },
  { id: 'main', agentId: 'main', name: 'Henry' },
  { id: 'hermes-trevor', agentId: 'hermes-trevor', name: 'Trevor' },
];

describe('canonicalizeTeammate (#1218)', () => {
  it('canonicalizes a known agentId in lowercase to the teammate name', () => {
    expect(canonicalizeTeammate('mikey', ROSTER)).toBe('Mikey');
    expect(canonicalizeTeammate('hermes-trevor', ROSTER)).toBe('Trevor');
  });

  it('canonicalizes a known name in mixed case', () => {
    expect(canonicalizeTeammate('mIkEy', ROSTER)).toBe('Mikey');
    expect(canonicalizeTeammate('  ANA  ', ROSTER)).toBe('Ana');
  });

  it('drops the "You" placeholder (any case) to null', () => {
    expect(canonicalizeTeammate('You', ROSTER)).toBeNull();
    expect(canonicalizeTeammate('you', ROSTER)).toBeNull();
    expect(canonicalizeTeammate('YOU', ROSTER)).toBeNull();
  });

  it('returns null for empty string and whitespace-only input', () => {
    expect(canonicalizeTeammate('', ROSTER)).toBeNull();
    expect(canonicalizeTeammate('   ', ROSTER)).toBeNull();
  });

  it('returns null for null and undefined input', () => {
    expect(canonicalizeTeammate(null, ROSTER)).toBeNull();
    expect(canonicalizeTeammate(undefined, ROSTER)).toBeNull();
  });

  it('passes unknown values through unchanged (external humans, etc.)', () => {
    expect(canonicalizeTeammate('SomeExternalHuman', ROSTER)).toBe('SomeExternalHuman');
    // Trim is applied
    expect(canonicalizeTeammate('  ExternalContractor  ', ROSTER)).toBe('ExternalContractor');
  });

  it('is safe when teammates is null/undefined/empty', () => {
    expect(canonicalizeTeammate('mikey', null)).toBe('mikey');
    expect(canonicalizeTeammate('mikey', undefined)).toBe('mikey');
    expect(canonicalizeTeammate('mikey', [])).toBe('mikey');
    // Still drops "You" and empties without a roster
    expect(canonicalizeTeammate('You', null)).toBeNull();
    expect(canonicalizeTeammate('', null)).toBeNull();
  });
});
