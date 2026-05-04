import { describe, it, expect } from 'vitest';
import {
  validateAddComment,
  resolveCommentAuthor,
  hasNonEmptyContent,
} from '@/lib/add-comment-validation';

// #1217: validation + author-resolution for POST /api/store action=addComment.
//
// Bug A (empty body): comment surfaces silently saved rows with no
// content/body/text. Backend now rejects with 400.
//
// Bug B (author mis-attribution): apikey/noauth had a hardcoded fallback to
// 'basil', so any agent posting via the global Bearer token without an
// explicit `comment.author` got rewritten to 'Basil'. Validation now requires
// an explicit author for apikey, and the resolver only rewrites
// 'You'/missing authors when auth method is `session`.
describe('validateAddComment (#1217)', () => {
  describe('Bug A — empty body guard', () => {
    it('rejects when comment is missing', () => {
      const r = validateAddComment({}, 'session');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(400);
        expect(r.error).toMatch(/comment payload required/);
      }
    });

    it('rejects when content + body + text are all empty strings', () => {
      const r = validateAddComment(
        { comment: { author: 'Mikey', content: '', body: '', text: '' } },
        'session',
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(400);
        expect(r.error).toMatch(/non-empty content/);
      }
    });

    it('rejects when content is whitespace-only', () => {
      const r = validateAddComment(
        { comment: { author: 'Mikey', content: '   \n\t  ' } },
        'session',
      );
      expect(r.ok).toBe(false);
    });

    it('accepts when only `body` (legacy) is populated', () => {
      const r = validateAddComment(
        { comment: { author: 'Mikey', body: 'hello' } },
        'session',
      );
      expect(r.ok).toBe(true);
    });

    it('accepts when only `text` (legacy) is populated', () => {
      const r = validateAddComment(
        { comment: { author: 'Mikey', text: 'hello' } },
        'session',
      );
      expect(r.ok).toBe(true);
    });
  });

  describe('Bug B — apikey requires explicit author', () => {
    it('rejects empty content via apikey (empty body wins over author check)', () => {
      const r = validateAddComment({ comment: {} }, 'apikey');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/non-empty content/);
    });

    it('rejects missing author via apikey', () => {
      const r = validateAddComment(
        { comment: { content: 'hello from agent' } },
        'apikey',
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(400);
        expect(r.error).toMatch(/author required when posting via API key/);
      }
    });

    it('rejects whitespace-only author via apikey', () => {
      const r = validateAddComment(
        { comment: { author: '   ', content: 'hi' } },
        'apikey',
      );
      expect(r.ok).toBe(false);
    });

    it('accepts explicit author via apikey', () => {
      const r = validateAddComment(
        { comment: { author: 'Mikey', content: 'hi' } },
        'apikey',
      );
      expect(r.ok).toBe(true);
    });

    it('does not require author for session auth', () => {
      const r = validateAddComment(
        { comment: { content: 'hi from session user' } },
        'session',
      );
      expect(r.ok).toBe(true);
    });
  });
});

describe('resolveCommentAuthor (#1217)', () => {
  const teammates = [
    { id: 'mikey', name: 'Mikey', agentId: 'mikey' },
    { id: 'user-basil-123', name: 'Basil', agentId: 'basil' },
  ];

  it('Bug B regression: explicit author via apikey is preserved verbatim', () => {
    expect(
      resolveCommentAuthor('Mikey', 'apikey', null, teammates),
    ).toBe('Mikey');
  });

  it('Bug B regression: explicit author via apikey survives even with a userId hint', () => {
    // Old behavior would have ignored 'Mikey' and resolved 'basil' from the
    // hardcoded apikey userId. New behavior trusts the payload.
    expect(
      resolveCommentAuthor('Mikey', 'apikey', 'basil', teammates),
    ).toBe('Mikey');
  });

  it('apikey with empty author returns Unknown (validation should have blocked this)', () => {
    expect(
      resolveCommentAuthor(undefined, 'apikey', null, teammates),
    ).toBe('Unknown');
  });

  it('session auth: "You" resolves to teammate name via userId match', () => {
    expect(
      resolveCommentAuthor('You', 'session', 'mikey', teammates),
    ).toBe('Mikey');
  });

  it('session auth: missing author resolves to teammate name via userId match', () => {
    expect(
      resolveCommentAuthor(undefined, 'session', 'user-basil-123', teammates),
    ).toBe('Basil');
  });

  it('session auth: explicit non-You author is preserved', () => {
    expect(
      resolveCommentAuthor('Henry', 'session', 'mikey', teammates),
    ).toBe('Henry');
  });

  it('session auth with no userId falls back to Unknown (not basil!)', () => {
    expect(
      resolveCommentAuthor(undefined, 'session', null, teammates),
    ).toBe('Unknown');
  });

  it('session auth: matches teammate by lowercase name', () => {
    expect(
      resolveCommentAuthor('You', 'session', 'MIKEY', teammates),
    ).toBe('Mikey');
  });

  it('noauth: explicit author preserved', () => {
    expect(
      resolveCommentAuthor('TestBot', 'noauth', null, teammates),
    ).toBe('TestBot');
  });

  it('noauth: missing author returns Unknown (no silent basil fallback)', () => {
    expect(
      resolveCommentAuthor(undefined, 'noauth', null, teammates),
    ).toBe('Unknown');
  });
});

describe('hasNonEmptyContent', () => {
  it('returns false for undefined', () => {
    expect(hasNonEmptyContent(undefined)).toBe(false);
  });
  it('returns false for empty object', () => {
    expect(hasNonEmptyContent({})).toBe(false);
  });
  it('returns true if content is set', () => {
    expect(hasNonEmptyContent({ content: 'x' })).toBe(true);
  });
  it('returns true if body is set', () => {
    expect(hasNonEmptyContent({ body: 'x' })).toBe(true);
  });
  it('returns true if text is set', () => {
    expect(hasNonEmptyContent({ text: 'x' })).toBe(true);
  });
  it('returns false if all are whitespace', () => {
    expect(
      hasNonEmptyContent({ content: '  ', body: '\n', text: '\t' }),
    ).toBe(false);
  });
});
