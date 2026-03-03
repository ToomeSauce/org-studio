'use client';

import { PageHeader } from '@/components/PageHeader';
import { Bot, ChevronDown, Circle, Users } from 'lucide-react';
import { clsx } from 'clsx';

interface Agent {
  id: string;
  name: string;
  emoji: string;
  title: string;
  description: string;
  status: 'active' | 'standby' | 'planned';
  reportsTo?: string;
  avatarColor: string;
  avatarBg: string;
}

const AGENTS: Agent[] = [
  {
    id: 'henry',
    name: 'Henry Toome',
    emoji: '🧄',
    title: 'Chief of Staff',
    description: 'Coordinates all agent activities. Manages email, calendar, family logistics, and cross-team priorities. Primary point of contact for Basil.',
    status: 'active',
    avatarColor: 'text-[var(--accent-primary)]',
    avatarBg: 'bg-[rgba(255,92,92,0.15)]',
  },
  {
    id: 'ana',
    name: 'Ana',
    emoji: '⚡',
    title: 'Fullstack Developer — Catpilot & Thrivor',
    description: 'Owns the Catpilot coaching platform and its future LMS evolution (Thrivor). Handles grader v2, short-form learning (Module 343), Studio Quick Create, test suites, and frontend/backend features.',
    status: 'active',
    reportsTo: 'henry',
    avatarColor: 'text-yellow-400',
    avatarBg: 'bg-[rgba(250,204,21,0.12)]',
  },
  {
    id: 'mikey',
    name: 'Mikey',
    emoji: '🔬',
    title: 'Fullstack Developer — Labs & Experiments',
    description: 'Builds experimental products: Garage dashboard, AI voice calling service, and future prototypes. Ships MVPs fast, iterates based on feedback.',
    status: 'active',
    reportsTo: 'henry',
    avatarColor: 'text-cyan-400',
    avatarBg: 'bg-[rgba(34,211,238,0.12)]',
  },
  {
    id: 'sam',
    name: 'Sam',
    emoji: '⚖️',
    title: 'Legal Counsel',
    description: 'Advises on family law, custody arrangements, child support proceedings, and communications with opposing counsel. Research and preparation support.',
    status: 'active',
    reportsTo: 'henry',
    avatarColor: 'text-purple-400',
    avatarBg: 'bg-[rgba(168,85,247,0.12)]',
  },
];

// Future sub-agents
const SUBAGENT_SLOTS = [
  { parent: 'ana', roles: ['Test Runner', 'Frontend Builder', 'DB Migrator'] },
  { parent: 'mikey', roles: ['Voice Engineer', 'API Builder', 'Experiment Runner'] },
];

function AgentCard({ agent, large = false }: { agent: Agent; large?: boolean }) {
  return (
    <div className={clsx(
      'bg-[var(--card)] border border-[var(--border-default)] rounded-[var(--radius-lg)]',
      'hover:border-[var(--border-strong)] transition-all duration-200',
      'shadow-[var(--shadow-sm),inset_0_1px_0_var(--card-highlight)]',
      large ? 'p-6' : 'p-4',
      large && 'hover:shadow-[var(--shadow-md),0_0_20px_var(--accent-glow)]'
    )}>
      <div className="flex items-start gap-3.5">
        {/* Avatar */}
        <div className={clsx(
          'rounded-full flex items-center justify-center shrink-0',
          agent.avatarBg,
          large ? 'w-14 h-14 text-2xl' : 'w-10 h-10 text-lg'
        )}>
          {agent.emoji}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <h3 className={clsx('font-bold text-[var(--text-primary)] tracking-tight', large ? 'text-lg' : 'text-sm')}>
              {agent.name}
            </h3>
            <div className={clsx(
              'w-2 h-2 rounded-full',
              agent.status === 'active' ? 'bg-[var(--success)] shadow-[0_0_6px_rgba(34,197,94,0.5)]' : 'bg-zinc-600'
            )} />
          </div>
          <p className={clsx('font-medium mb-1.5', agent.avatarColor, large ? 'text-sm' : 'text-[12px]')}>
            {agent.title}
          </p>
          <p className={clsx('text-[var(--text-tertiary)] leading-relaxed', large ? 'text-sm' : 'text-[11px]')}>
            {agent.description}
          </p>
        </div>
      </div>
    </div>
  );
}

function SubagentSlot({ role }: { role: string }) {
  return (
    <div className="bg-[var(--bg-secondary)] border border-dashed border-[var(--border-default)] rounded-[var(--radius-md)] px-3 py-2.5 text-center hover:border-[var(--border-strong)] transition-colors">
      <Bot size={14} className="mx-auto text-[var(--text-muted)] mb-1" />
      <p className="text-[11px] font-medium text-[var(--text-muted)]">{role}</p>
      <p className="text-[9px] text-[var(--text-muted)] opacity-60 mt-0.5">spawn on demand</p>
    </div>
  );
}

export default function TeamPage() {
  const henry = AGENTS.find(a => a.id === 'henry')!;
  const reports = AGENTS.filter(a => a.reportsTo === 'henry');

  return (
    <div className="space-y-8">
      <PageHeader title="Team" description="Agent org chart and roles" />

      {/* Mission statement */}
      <div className="bg-gradient-to-r from-[rgba(255,92,92,0.08)] to-[rgba(139,92,246,0.08)] border border-[rgba(255,92,92,0.2)] rounded-[var(--radius-lg)] p-6 text-center">
        <Users size={24} className="mx-auto text-[var(--accent-primary)] mb-3 opacity-80" />
        <p className="text-lg font-semibold text-[var(--text-primary)] tracking-tight leading-relaxed max-w-2xl mx-auto">
          "A collaborative team of agents that delivers secure, innovative value for me 24/7"
        </p>
        <p className="text-xs text-[var(--text-muted)] mt-2">— Team Mission</p>
      </div>

      {/* Org chart */}
      <div className="flex flex-col items-center gap-0">
        {/* Henry — top of chart */}
        <div className="w-full max-w-lg">
          <AgentCard agent={henry} large />
        </div>

        {/* Connector */}
        <div className="flex flex-col items-center py-1">
          <div className="w-px h-6 bg-[var(--border-strong)]" />
          <ChevronDown size={16} className="text-[var(--border-strong)] -my-1" />
        </div>

        {/* Direct reports */}
        <div className="w-full">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 relative">
            {/* Horizontal connector line */}
            <div className="hidden md:block absolute top-0 left-[16.67%] right-[16.67%] h-px bg-[var(--border-strong)]" style={{ top: '-1px' }} />

            {reports.map(agent => (
              <div key={agent.id} className="flex flex-col items-center">
                {/* Vertical connector */}
                <div className="hidden md:block w-px h-4 bg-[var(--border-strong)] mb-2" />
                <div className="w-full">
                  <AgentCard agent={agent} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Sub-agent slots */}
        <div className="w-full mt-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {SUBAGENT_SLOTS.map(slot => {
              const parent = AGENTS.find(a => a.id === slot.parent);
              return (
                <div key={slot.parent}>
                  <div className="flex items-center gap-2 mb-2 px-1">
                    <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wide">
                      {parent?.name}'s Sub-agents
                    </span>
                    <span className="text-[9px] text-[var(--text-muted)] opacity-60">(ephemeral)</span>
                  </div>
                  <div className="grid grid-cols-1 gap-2">
                    {slot.roles.map(role => (
                      <SubagentSlot key={role} role={role} />
                    ))}
                  </div>
                </div>
              );
            })}
            {/* Sam column — no sub-agents */}
            <div className="flex items-center justify-center text-[11px] text-[var(--text-muted)] opacity-50 italic">
              No sub-agents needed
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
