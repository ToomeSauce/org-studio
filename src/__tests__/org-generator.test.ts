import { describe, it, expect } from 'vitest';
import { generateOrgMd, generateGenericOrgMd } from '@/lib/org-generator';
import type { Teammate } from '@/lib/teammates';

function makeTeammates(): Teammate[] {
  return [
    {
      id: 'tm-1',
      agentId: 'main',
      name: 'Riley',
      emoji: '📋',
      title: 'Chief of Staff',
      domain: 'Coordination',
      owns: 'Email, calendar, cross-cutting ops',
      defers: 'Production deployments',
      description: 'Cross-cutting coordination and personal ops',
      color: 'emerald',
      isHuman: false,
    },
    {
      id: 'tm-2',
      agentId: 'ana',
      name: 'Ana',
      emoji: '💻',
      title: 'Platform Engineer',
      domain: 'Platform Engineering',
      owns: 'Platform code, CI/CD',
      defers: 'Infrastructure spend',
      description: 'Platform engineering and development',
      color: 'purple',
      isHuman: false,
    },
    {
      id: 'tm-3',
      agentId: 'mikey',
      name: 'Alex',
      emoji: '🔬',
      title: 'Labs Developer',
      domain: 'Labs & Experiments',
      owns: 'Voice service, prototypes',
      defers: 'Public-facing comms',
      description: 'Experimental projects and MVPs',
      color: 'cyan',
      isHuman: false,
    },
    {
      id: 'tm-4',
      agentId: '',
      name: 'Jordan',
      emoji: '👤',
      title: 'Founder',
      domain: 'Everything',
      description: 'The boss',
      color: 'red',
      isHuman: true,
    },
  ];
}

function makeContext(overrides: Record<string, any> = {}) {
  return {
    missionStatement: 'Foster continuous learning and growth with coaching agents that make hard things easy.',
    values: {
      name: 'P.A.C.T.',
      items: [
        { letter: 'P', icon: '📣', title: 'People-First', description: 'Obsessed with the people we serve.' },
        { letter: 'A', icon: '🔥', title: 'Autonomy', description: 'Own your domain, act on what matters.' },
        { letter: 'C', icon: '🔍', title: 'Curiosity', description: 'Ask why, dig deeper, never stop learning.' },
        { letter: 'T', icon: '🤝', title: 'Teamwork', description: 'Work together, communicate openly.' },
      ],
    },
    teammates: makeTeammates(),
    ...overrides,
  };
}

describe('generateOrgMd', () => {
  it('includes mission statement', () => {
    const ctx = makeContext();
    const md = generateOrgMd(ctx);

    expect(md).toContain('## Mission');
    expect(md).toContain('Foster continuous learning and growth');
  });

  it('includes values section with all value items', () => {
    const ctx = makeContext();
    const md = generateOrgMd(ctx);

    expect(md).toContain('## Values — P.A.C.T.');
    expect(md).toContain('**People-First**');
    expect(md).toContain('**Autonomy**');
    expect(md).toContain('**Curiosity**');
    expect(md).toContain('**Teamwork**');
  });

  it('includes team section listing all teammates', () => {
    const ctx = makeContext();
    const md = generateOrgMd(ctx);

    expect(md).toContain('## Team');
    expect(md).toContain('**Riley**');
    expect(md).toContain('**Ana**');
    expect(md).toContain('**Alex**');
    expect(md).toContain('**Jordan**');
  });

  it('marks humans and agents correctly in team roster', () => {
    const ctx = makeContext();
    const md = generateOrgMd(ctx);

    // Jordan is human
    expect(md).toContain('**Jordan** 👤 (Human)');
    // Riley is an agent
    expect(md).toContain('**Riley** 📋 (Agent)');
  });

  it('includes Owns/Defers for a specific agent', () => {
    const ctx = makeContext();
    const md = generateOrgMd(ctx, 'mikey');

    expect(md).toContain('## Your Domain: Labs & Experiments');
    expect(md).toContain('**Role:** Labs Developer');
    expect(md).toContain('**Owns (autonomous decisions):** Voice service, prototypes');
    expect(md).toContain('**Defers (needs confirmation):** Public-facing comms');
  });

  it('omits Your Domain section for generic (no agent) output', () => {
    const ctx = makeContext();
    const md = generateOrgMd(ctx);

    expect(md).not.toContain('## Your Domain');
    expect(md).not.toContain('**Owns (autonomous decisions):**');
  });

  it('handles missing mission gracefully', () => {
    const ctx = makeContext({ missionStatement: '' });
    const md = generateOrgMd(ctx);

    expect(md).toContain('No mission defined.');
  });

  it('omits values section when no values provided', () => {
    const ctx = makeContext({ values: undefined });
    const md = generateOrgMd(ctx);

    expect(md).not.toContain('## Values');
  });

  it('handles unknown agentId gracefully (no Your Domain section)', () => {
    const ctx = makeContext();
    const md = generateOrgMd(ctx, 'nonexistent-agent');

    // Should not crash, just skip the domain section
    expect(md).not.toContain('## Your Domain');
    expect(md).toContain('## Team'); // rest still renders
  });

  it('includes auto-generated header', () => {
    const ctx = makeContext();
    const md = generateOrgMd(ctx);

    expect(md).toContain('# Org Context');
    expect(md).toContain('Auto-generated by Org Studio');
  });

  it('includes owns info in team roster line', () => {
    const ctx = makeContext();
    const md = generateOrgMd(ctx);

    expect(md).toContain('Owns: Email, calendar, cross-cutting ops');
    expect(md).toContain('Owns: Platform code, CI/CD');
  });
});

describe('generateGenericOrgMd', () => {
  it('produces same output as generateOrgMd with no agentId', () => {
    const ctx = makeContext();
    const generic = generateGenericOrgMd(ctx);
    const noAgent = generateOrgMd(ctx);

    expect(generic).toBe(noAgent);
  });
});
