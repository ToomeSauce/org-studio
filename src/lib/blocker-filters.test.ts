import { describe, it, expect } from 'vitest';
import { isAwaitingHumanResponse } from './blocker-filters';

describe('isAwaitingHumanResponse', () => {
  it('returns false for a vanilla blocked task with no signal', () => {
    expect(isAwaitingHumanResponse({})).toBe(false);
  });

  it('returns true when needsUserResponse=true', () => {
    expect(isAwaitingHumanResponse({ needsUserResponse: true })).toBe(true);
  });

  it('returns false when needsUserResponse=false and no other signal', () => {
    expect(isAwaitingHumanResponse({ needsUserResponse: false })).toBe(false);
  });

  it('returns true when awaitingResponseFrom is a string matching a human owner', () => {
    expect(isAwaitingHumanResponse({ awaitingResponseFrom: 'basil' })).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(isAwaitingHumanResponse({ awaitingResponseFrom: 'Basil' })).toBe(true);
    expect(isAwaitingHumanResponse({ awaitingResponseFrom: '  BASIL  ' })).toBe(true);
  });

  it('returns false when awaitingResponseFrom names another agent', () => {
    expect(isAwaitingHumanResponse({ awaitingResponseFrom: 'trevor' })).toBe(false);
    expect(isAwaitingHumanResponse({ awaitingResponseFrom: 'ana' })).toBe(false);
  });

  it('handles array form', () => {
    expect(isAwaitingHumanResponse({ awaitingResponseFrom: ['trevor', 'basil'] })).toBe(true);
    expect(isAwaitingHumanResponse({ awaitingResponseFrom: ['trevor', 'ana'] })).toBe(false);
    expect(isAwaitingHumanResponse({ awaitingResponseFrom: [] })).toBe(false);
  });

  it('handles empty/null/undefined', () => {
    expect(isAwaitingHumanResponse({ awaitingResponseFrom: '' })).toBe(false);
    expect(isAwaitingHumanResponse({ awaitingResponseFrom: null as any })).toBe(false);
    expect(isAwaitingHumanResponse({ awaitingResponseFrom: undefined })).toBe(false);
  });

  it('respects custom humanOwners list', () => {
    expect(isAwaitingHumanResponse({ awaitingResponseFrom: 'alice' }, ['alice'])).toBe(true);
    expect(isAwaitingHumanResponse({ awaitingResponseFrom: 'basil' }, ['alice'])).toBe(false);
  });

  it('needsUserResponse short-circuits regardless of awaitingResponseFrom', () => {
    expect(
      isAwaitingHumanResponse({ needsUserResponse: true, awaitingResponseFrom: 'trevor' })
    ).toBe(true);
  });
});
