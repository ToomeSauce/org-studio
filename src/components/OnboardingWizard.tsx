'use client';

import { useState, useCallback, useEffect } from 'react';
import { ArrowRight, ArrowLeft, Plus, Sparkles, Check, Users, FolderKanban, Rocket, Wifi, Loader } from 'lucide-react';

// ─── Types ───────────────────────────────────────────────────────────────────

interface NewTeammate {
  name: string;
  title: string;
  isHuman: boolean;
  domain: string;
  emoji: string;
  agentId: string;
}

interface NewProject {
  name: string;
  description: string;
  owner: string;
}

interface OnboardingWizardProps {
  onComplete: () => void;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const EMOJI_OPTIONS = ['👤', '🤖', '⚡', '🔬', '🧠', '🎯', '🛠️', '🌟', '🐝', '🦊'];

const STEP_LABELS = ['Organization', 'Runtime', 'Team', 'Project', 'Done'];

const DEFAULT_MISSION_PLACEHOLDER = 'e.g. Build products that make people\'s lives easier';
const DEFAULT_ORG_PLACEHOLDER = 'e.g. Acme Labs';

// ─── API helpers ─────────────────────────────────────────────────────────────

async function apiPost(action: string, payload: Record<string, any>) {
  const res = await fetch('/api/store', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  if (!res.ok) throw new Error(`Store action ${action} failed`);
  return res.json();
}

// ─── Component ───────────────────────────────────────────────────────────────

export function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<'forward' | 'back'>('forward');
  const [animating, setAnimating] = useState(false);

  // Step 0
  const [orgName, setOrgName] = useState('');
  const [mission, setMission] = useState('');

  // Step 1: Runtime
  const [detectedAgents, setDetectedAgents] = useState<any[]>([]);
  const [gatewayLoading, setGatewayLoading] = useState(false);
  const [gatewayConnected, setGatewayConnected] = useState(false);

  // Step 2
  const [teammates, setTeammates] = useState<NewTeammate[]>([]);
  const [tmName, setTmName] = useState('');
  const [tmTitle, setTmTitle] = useState('');
  const [tmIsHuman, setTmIsHuman] = useState(true);
  const [tmDomain, setTmDomain] = useState('');
  const [tmEmoji, setTmEmoji] = useState('👤');
  const [tmAgentId, setTmAgentId] = useState('');

  // Step 3
  const [projName, setProjName] = useState('');
  const [projDesc, setProjDesc] = useState('');
  const [projOwner, setProjOwner] = useState('');

  // Final
  const [finishing, setFinishing] = useState(false);

  const totalSteps = 5; // 0-4

  // Poll Gateway for agents when entering step 1
  useEffect(() => {
    if (step === 1) {
      pollGatewayAgents();
    }
  }, [step]);

  const pollGatewayAgents = async () => {
    setGatewayLoading(true);
    try {
      const response = await fetch('/api/gateway', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'agents.list' }),
      });
      const data = await response.json();
      if (data.result && Array.isArray(data.result.agents)) {
        setDetectedAgents(data.result.agents);
        setGatewayConnected(true);
      }
    } catch (err) {
      console.error('Failed to poll Gateway agents:', err);
      setGatewayConnected(false);
    } finally {
      setGatewayLoading(false);
    }
  };

  const goTo = useCallback((target: number) => {
    if (animating) return;
    setDirection(target > step ? 'forward' : 'back');
    setAnimating(true);
    setTimeout(() => {
      setStep(target);
      setTimeout(() => setAnimating(false), 350);
    }, 10);
  }, [step, animating]);

  const next = () => goTo(step + 1);
  const back = () => goTo(step - 1);

  const addTeammate = () => {
    if (!tmName.trim()) return;
    setTeammates(prev => [...prev, {
      name: tmName.trim(),
      title: tmTitle.trim(),
      isHuman: tmIsHuman,
      domain: tmDomain.trim(),
      emoji: tmEmoji,
      agentId: tmIsHuman ? '' : tmAgentId.trim(),
    }]);
    setTmName('');
    setTmTitle('');
    setTmDomain('');
    setTmEmoji('👤');
    setTmAgentId('');
    setTmIsHuman(true);
  };

  const removeTeammate = (index: number) => {
    setTeammates(prev => prev.filter((_, i) => i !== index));
  };

  const finish = async () => {
    setFinishing(true);
    try {
      await apiPost('updateSettings', {
        settings: {
          orgName: orgName.trim() || undefined,
          missionStatement: mission.trim() || undefined,
          onboardingComplete: true,
        },
      });

      for (const tm of teammates) {
        const id = tm.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
        await apiPost('addTeammate', {
          teammate: {
            id,
            name: tm.name,
            emoji: tm.emoji,
            title: tm.title || undefined,
            domain: tm.domain || undefined,
            isHuman: tm.isHuman,
            agentId: tm.agentId || '',
            color: tm.isHuman ? 'amber' : 'cyan',
            description: '',
          },
        });
      }

      if (projName.trim()) {
        await apiPost('addProject', {
          project: {
            name: projName.trim(),
            description: projDesc.trim() || '',
            owner: projOwner || '',
            phase: 'active',
            priority: 'medium',
            createdBy: 'onboarding',
          },
        });
      }

      onComplete();
    } catch (err) {
      console.error('Onboarding save failed:', err);
      setFinishing(false);
    }
  };

  const StepIndicator = () => (
    <div className="flex items-center justify-center gap-3 mb-12">
      {STEP_LABELS.map((label, i) => (
        <div key={i} className="flex items-center gap-3">
          <button
            onClick={() => i < step ? goTo(i) : undefined}
            className={`flex items-center gap-2 transition-all duration-300 ${i < step ? 'cursor-pointer' : 'cursor-default'}`}
          >
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-[13px] font-semibold transition-all duration-300 ${i === step ? 'bg-[var(--accent-primary)] text-white shadow-[0_0_20px_var(--accent-glow)]' : i < step ? 'bg-[var(--success)] text-white' : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]'}`}>
              {i < step ? <Check size={14} /> : i + 1}
            </div>
            <span className={`text-[13px] font-medium hidden sm:inline transition-colors duration-300 ${i === step ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}`}>
              {label}
            </span>
          </button>
          {i < STEP_LABELS.length - 1 && (
            <div className={`w-8 h-px transition-colors duration-300 ${i < step ? 'bg-[var(--success)]' : 'bg-[var(--border-default)]'}`} />
          )}
        </div>
      ))}
    </div>
  );

  const renderStep0 = () => (
    <div className="max-w-lg mx-auto text-center">
      <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-[var(--accent-muted)] mb-6">
        <Sparkles size={28} className="text-[var(--accent-primary)]" />
      </div>
      <h1 className="text-[var(--text-3xl)] font-bold text-[var(--text-primary)] mb-3 tracking-tight">
        Name Your Organization
      </h1>
      <p className="text-[var(--text-md)] text-[var(--text-tertiary)] mb-10 leading-relaxed">
        What's your team called? This shows up in the sidebar and sets the tone.
      </p>

      <div className="space-y-5 text-left">
        <div>
          <label className="block text-[var(--text-xs)] font-medium text-[var(--text-tertiary)] mb-2 uppercase tracking-wider">
            Organization Name
          </label>
          <input
            type="text"
            value={orgName}
            onChange={e => setOrgName(e.target.value)}
            placeholder={DEFAULT_ORG_PLACEHOLDER}
            className="w-full bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] px-4 py-3 text-[var(--text-base)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)] transition-colors"
            autoFocus
          />
        </div>

        <div>
          <label className="block text-[var(--text-xs)] font-medium text-[var(--text-tertiary)] mb-2 uppercase tracking-wider">
            Mission Statement
          </label>
          <textarea
            value={mission}
            onChange={e => setMission(e.target.value)}
            placeholder={DEFAULT_MISSION_PLACEHOLDER}
            rows={3}
            className="w-full bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] px-4 py-3 text-[var(--text-base)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)] transition-colors resize-none leading-relaxed"
          />
          <p className="text-[var(--text-xs)] text-[var(--text-muted)] mt-1.5">
            Both optional — you can always change these later in Settings.
          </p>
        </div>
      </div>
    </div>
  );

  const renderStep1 = () => (
    <div className="max-w-xl mx-auto">
      <div className="text-center mb-10">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-[var(--info-subtle)] mb-6">
          <Wifi size={28} className="text-[var(--info)]" />
        </div>
        <h1 className="text-[var(--text-3xl)] font-bold text-[var(--text-primary)] mb-3 tracking-tight">
          Connect Your Agent Runtime
        </h1>
        <p className="text-[var(--text-md)] text-[var(--text-tertiary)] leading-relaxed">
          Org Studio can auto-detect agents from OpenClaw. Skip this if you're running standalone.
        </p>
      </div>

      <div className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-lg)] p-6 space-y-5">
        <div>
          <div className="flex items-center gap-3 mb-4">
            <button
              onClick={pollGatewayAgents}
              disabled={gatewayLoading}
              className="flex items-center gap-2 px-4 py-2.5 rounded-[var(--radius-md)] text-[var(--text-sm)] font-medium transition-all bg-[var(--accent-primary)] text-white hover:bg-[var(--accent-hover)] disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {gatewayLoading ? (
                <>
                  <Loader size={14} className="animate-spin" /> Connecting...
                </>
              ) : (
                <>
                  <Wifi size={14} /> Check Gateway
                </>
              )}
            </button>
          </div>

          {gatewayConnected && detectedAgents.length > 0 ? (
            <div className="space-y-3">
              <p className="text-[var(--text-sm)] font-semibold text-[var(--success)] flex items-center gap-2">
                <Check size={16} /> {detectedAgents.length} agent{detectedAgents.length !== 1 ? 's' : ''} detected
              </p>
              <div className="space-y-2">
                {detectedAgents.map((agent) => (
                  <div
                    key={agent.id}
                    className="flex items-center gap-3 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[var(--radius-md)] px-3 py-2.5"
                  >
                    <span className="text-lg">{agent.identity?.emoji || '🤖'}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-[var(--text-sm)] font-medium text-[var(--text-primary)] truncate">
                        {agent.identity?.name || agent.name || agent.id}
                      </p>
                      <p className="text-[var(--text-xs)] text-[var(--text-muted)] truncate font-mono">{agent.id}</p>
                    </div>
                    <span className="text-[var(--text-xs)] font-medium px-2 py-0.5 rounded-full bg-[var(--success-subtle)] text-[var(--success)]">
                      Ready
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-[var(--text-xs)] text-[var(--text-muted)] mt-3">
                These agents will appear in your team roster automatically.
              </p>
            </div>
          ) : !gatewayLoading && gatewayConnected === false ? (
            <div className="bg-[var(--warning-subtle)] border border-[var(--warning-subtle)] rounded-[var(--radius-md)] p-3">
              <p className="text-[var(--text-sm)] text-[var(--text-primary)] font-medium mb-1">
                Gateway not found
              </p>
              <p className="text-[var(--text-xs)] text-[var(--text-muted)]">
                Make sure OpenClaw is running and accessible at http://localhost:18789. You can skip this and add agents manually later.
              </p>
            </div>
          ) : null}
        </div>

        <div>
          <p className="text-[var(--text-xs)] font-medium text-[var(--text-tertiary)] uppercase tracking-wider mb-2">
            Configuration
          </p>
          <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[var(--radius-md)] px-3 py-2.5 font-mono text-[var(--text-xs)] text-[var(--text-muted)] max-h-20 overflow-y-auto">
            <div>GATEWAY_URL: http://localhost:18789</div>
            <div>STATUS: {gatewayConnected ? '✓ Connected' : '✗ Not connected'}</div>
          </div>
        </div>
      </div>
    </div>
  );

  const renderStep2 = () => (
    <div className="max-w-xl mx-auto">
      <div className="text-center mb-10">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-[var(--accent-2-subtle)] mb-6">
          <Users size={28} className="text-[var(--accent-2)]" />
        </div>
        <h1 className="text-[var(--text-3xl)] font-bold text-[var(--text-primary)] mb-3 tracking-tight">
          Add Human Team Members
        </h1>
        <p className="text-[var(--text-md)] text-[var(--text-tertiary)] leading-relaxed">
          Detected agents are already added. Add any humans here.
        </p>
      </div>

      <div className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-lg)] p-5 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-[var(--text-xs)] font-medium text-[var(--text-tertiary)] mb-1.5 uppercase tracking-wider">Name *</label>
            <input
              type="text"
              value={tmName}
              onChange={e => setTmName(e.target.value)}
              placeholder="e.g. Alex"
              className="w-full bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[var(--radius-md)] px-3 py-2.5 text-[var(--text-sm)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)] transition-colors"
            />
          </div>
          <div>
            <label className="block text-[var(--text-xs)] font-medium text-[var(--text-tertiary)] mb-1.5 uppercase tracking-wider">Role / Title</label>
            <input
              type="text"
              value={tmTitle}
              onChange={e => setTmTitle(e.target.value)}
              placeholder="e.g. Engineer"
              className="w-full bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[var(--radius-md)] px-3 py-2.5 text-[var(--text-sm)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)] transition-colors"
            />
          </div>
        </div>

        <div>
          <label className="block text-[var(--text-xs)] font-medium text-[var(--text-tertiary)] mb-1.5 uppercase tracking-wider">Domain</label>
          <input
            type="text"
            value={tmDomain}
            onChange={e => setTmDomain(e.target.value)}
            placeholder="e.g. Backend, Design, Ops"
            className="w-full bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[var(--radius-md)] px-3 py-2.5 text-[var(--text-sm)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)] transition-colors"
          />
        </div>

        <div>
          <label className="block text-[var(--text-xs)] font-medium text-[var(--text-tertiary)] mb-2 uppercase tracking-wider">Emoji</label>
          <div className="flex gap-2 flex-wrap">
            {EMOJI_OPTIONS.map(e => (
              <button
                key={e}
                onClick={() => setTmEmoji(e)}
                className={`w-10 h-10 rounded-[var(--radius-md)] text-lg flex items-center justify-center border transition-all ${tmEmoji === e ? 'border-[var(--accent-primary)] bg-[var(--accent-muted)] shadow-[0_0_12px_var(--accent-glow)]' : 'border-[var(--border-default)] bg-[var(--bg-primary)] hover:border-[var(--border-strong)]'}`}
              >
                {e}
              </button>
            ))}
          </div>
        </div>

        <button
          onClick={addTeammate}
          disabled={!tmName.trim()}
          className="w-full flex items-center justify-center gap-2 py-2.5 rounded-[var(--radius-md)] text-[var(--text-sm)] font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed bg-[var(--accent-primary)] text-white hover:bg-[var(--accent-hover)]"
        >
          <Plus size={15} /> Add Human
        </button>
      </div>

      {teammates.length > 0 && (
        <div className="mt-5 space-y-2">
          <p className="text-[var(--text-xs)] font-medium text-[var(--text-tertiary)] uppercase tracking-wider mb-2">
            Added ({teammates.length})
          </p>
          {teammates.map((tm, i) => (
            <div key={i} className="flex items-center gap-3 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] px-4 py-3">
              <span className="text-xl">{tm.emoji}</span>
              <div className="flex-1 min-w-0">
                <p className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)] truncate">{tm.name}</p>
                <p className="text-[var(--text-xs)] text-[var(--text-muted)] truncate">
                  {tm.title || 'Human'}
                  {tm.domain ? ` · ${tm.domain}` : ''}
                </p>
              </div>
              <span className="text-[var(--text-xs)] font-medium px-2 py-0.5 rounded-full bg-[var(--warning-subtle)] text-[var(--warning)]">
                Human
              </span>
              <button
                onClick={() => removeTeammate(i)}
                className="text-[var(--text-muted)] hover:text-[var(--error)] transition-colors text-lg leading-none"
                title="Remove"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const renderStep3 = () => (
    <div className="max-w-lg mx-auto text-center">
      <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-[var(--info-subtle)] mb-6">
        <FolderKanban size={28} className="text-[var(--info)]" />
      </div>
      <h1 className="text-[var(--text-3xl)] font-bold text-[var(--text-primary)] mb-3 tracking-tight">
        Create Your First Project
      </h1>
      <p className="text-[var(--text-md)] text-[var(--text-tertiary)] mb-10 leading-relaxed">
        Optional — you can always do this later from the Vision board.
      </p>

      <div className="space-y-4 text-left">
        <div>
          <label className="block text-[var(--text-xs)] font-medium text-[var(--text-tertiary)] mb-1.5 uppercase tracking-wider">
            Project Name
          </label>
          <input
            type="text"
            value={projName}
            onChange={e => setProjName(e.target.value)}
            placeholder="e.g. Website Redesign"
            className="w-full bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] px-4 py-3 text-[var(--text-base)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)] transition-colors"
          />
        </div>

        <div>
          <label className="block text-[var(--text-xs)] font-medium text-[var(--text-tertiary)] mb-1.5 uppercase tracking-wider">
            Description
          </label>
          <textarea
            value={projDesc}
            onChange={e => setProjDesc(e.target.value)}
            placeholder="What's this project about?"
            rows={3}
            className="w-full bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] px-4 py-3 text-[var(--text-base)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)] transition-colors resize-none leading-relaxed"
          />
        </div>

        {(teammates.length > 0 || detectedAgents.length > 0) && (
          <div>
            <label className="block text-[var(--text-xs)] font-medium text-[var(--text-tertiary)] mb-1.5 uppercase tracking-wider">
              Owner
            </label>
            <select
              value={projOwner}
              onChange={e => setProjOwner(e.target.value)}
              className="w-full bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] px-4 py-3 text-[var(--text-base)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)] transition-colors appearance-none"
            >
              <option value="">Select an owner...</option>
              {teammates.map((tm, i) => (
                <option key={i} value={tm.name}>{tm.emoji} {tm.name}</option>
              ))}
              {detectedAgents.map((agent) => (
                <option key={agent.id} value={agent.identity?.name || agent.name || agent.id}>
                  {agent.identity?.emoji || '🤖'} {agent.identity?.name || agent.name || agent.id}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
    </div>
  );

  const renderStep4 = () => (
    <div className="max-w-lg mx-auto text-center">
      <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-[var(--success-subtle)] mb-6">
        <Rocket size={28} className="text-[var(--success)]" />
      </div>
      <h1 className="text-[var(--text-3xl)] font-bold text-[var(--text-primary)] mb-3 tracking-tight">
        You're all set!
      </h1>
      <p className="text-[var(--text-md)] text-[var(--text-tertiary)] mb-10 leading-relaxed">
        Here's what we're setting up for you.
      </p>

      <div className="space-y-3 text-left mb-10">
        {orgName.trim() && (
          <div className="flex items-center gap-3 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] px-4 py-3">
            <Sparkles size={16} className="text-[var(--accent-primary)] shrink-0" />
            <div>
              <p className="text-[var(--text-sm)] font-medium text-[var(--text-primary)]">{orgName.trim()}</p>
              {mission.trim() && <p className="text-[var(--text-xs)] text-[var(--text-muted)]">{mission.trim()}</p>}
            </div>
          </div>
        )}

        {(detectedAgents.length > 0 || teammates.length > 0) && (
          <div className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] px-4 py-3">
            <div className="flex items-center gap-2 mb-2">
              <Users size={16} className="text-[var(--accent-2)] shrink-0" />
              <p className="text-[var(--text-sm)] font-medium text-[var(--text-primary)]">
                {detectedAgents.length + teammates.length} teammate{detectedAgents.length + teammates.length !== 1 ? 's' : ''}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {detectedAgents.map((agent) => (
                <span key={agent.id} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[var(--bg-primary)] text-[var(--text-xs)] text-[var(--text-secondary)] border border-[var(--border-subtle)]">
                  <span>{agent.identity?.emoji || '🤖'}</span> {agent.identity?.name || agent.name || agent.id}
                </span>
              ))}
              {teammates.map((tm, i) => (
                <span key={i} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[var(--bg-primary)] text-[var(--text-xs)] text-[var(--text-secondary)] border border-[var(--border-subtle)]">
                  <span>{tm.emoji}</span> {tm.name}
                </span>
              ))}
            </div>
          </div>
        )}

        {projName.trim() && (
          <div className="flex items-center gap-3 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-md)] px-4 py-3">
            <FolderKanban size={16} className="text-[var(--info)] shrink-0" />
            <div>
              <p className="text-[var(--text-sm)] font-medium text-[var(--text-primary)]">{projName.trim()}</p>
              {projDesc.trim() && <p className="text-[var(--text-xs)] text-[var(--text-muted)]">{projDesc.trim()}</p>}
            </div>
          </div>
        )}

        {!orgName.trim() && detectedAgents.length === 0 && teammates.length === 0 && !projName.trim() && (
          <p className="text-[var(--text-sm)] text-[var(--text-muted)] text-center py-4">
            No worries — you can set everything up from the dashboard. Let's go!
          </p>
        )}
      </div>

      <button
        onClick={finish}
        disabled={finishing}
        className="inline-flex items-center gap-2 px-8 py-3.5 rounded-[var(--radius-md)] text-[var(--text-base)] font-semibold transition-all bg-[var(--accent-primary)] text-white hover:bg-[var(--accent-hover)] shadow-[var(--shadow-glow)] disabled:opacity-60"
      >
        {finishing ? (
          <>
            <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            Setting up...
          </>
        ) : (
          <>
            Go to Dashboard <ArrowRight size={16} />
          </>
        )}
      </button>
    </div>
  );

  const steps = [renderStep0, renderStep1, renderStep2, renderStep3, renderStep4];

  return (
    <div className="fixed inset-0 z-50 bg-[var(--bg-primary)] flex flex-col overflow-y-auto">
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-12">
        <StepIndicator />

        <div
          className="w-full transition-all duration-300 ease-out"
          style={{
            opacity: animating ? 0 : 1,
            transform: animating
              ? `translateX(${direction === 'forward' ? '40px' : '-40px'})`
              : 'translateX(0)',
          }}
        >
          {steps[step]()}
        </div>
      </div>

      {step < 4 && (
        <div className="sticky bottom-0 bg-[var(--bg-primary)] border-t border-[var(--border-default)] px-6 py-4">
          <div className="max-w-xl mx-auto flex items-center justify-between">
            {step > 0 ? (
              <button
                onClick={back}
                className="flex items-center gap-2 px-5 py-2.5 rounded-[var(--radius-md)] text-[var(--text-sm)] font-medium bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
              >
                <ArrowLeft size={15} /> Back
              </button>
            ) : <div />}

            <button
              onClick={next}
              className="flex items-center gap-2 px-6 py-2.5 rounded-[var(--radius-md)] text-[var(--text-sm)] font-semibold transition-all bg-[var(--accent-primary)] text-white hover:bg-[var(--accent-hover)]"
            >
              {step === 3 ? (projName.trim() ? 'Review' : 'Skip & Review') : 'Continue'} <ArrowRight size={15} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
