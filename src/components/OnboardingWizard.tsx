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

interface OnboardingWizardProps {
  onComplete: () => void;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const EMOJI_OPTIONS = ['👤', '🤖', '⚡', '🔬', '🧠', '🎯', '🛠️', '🌟', '🐝', '🦊'];

const STEP_LABELS = ['Welcome', 'Organization', 'Runtime', 'Team', 'Done'];

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
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');

  // Step 1
  const [orgName, setOrgName] = useState('');
  const [mission, setMission] = useState('');

  // Step 2: Runtime
  const [detectedAgents, setDetectedAgents] = useState<any[]>([]);
  const [runtimes, setRuntimes] = useState<any[]>([]);
  const [gatewayLoading, setGatewayLoading] = useState(false);
  const [gatewayConnected, setGatewayConnected] = useState(false);

  // Step 3: Team
  const [teammates, setTeammates] = useState<NewTeammate[]>([]);
  const [tmName, setTmName] = useState('');
  const [tmTitle, setTmTitle] = useState('');
  const [tmIsHuman, setTmIsHuman] = useState(true);
  const [tmEmoji, setTmEmoji] = useState('👤');
  const [tmAgentId, setTmAgentId] = useState('');

  // Final
  const [finishing, setFinishing] = useState(false);

  const totalSteps = 5; // 0-4

  // Poll Gateway for agents when entering step 2
  useEffect(() => {
    if (step === 2) {
      pollRuntimes();
    }
  }, [step]);

  // Apply theme to document
  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [theme]);

  const pollRuntimes = async () => {
    setGatewayLoading(true);
    try {
      const response = await fetch('/api/runtimes');
      const data = await response.json();
      if (data.runtimes) {
        setRuntimes(data.runtimes);
        // Flatten all agents from all connected runtimes
        const allAgents = data.runtimes
          .filter((r: any) => r.connected && r.agents?.length)
          .flatMap((r: any) => r.agents);
        setDetectedAgents(allAgents);
        setGatewayConnected(data.runtimes.some((r: any) => r.connected));
      }
    } catch (err) {
      console.error('Failed to poll runtimes:', err);
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
      domain: '', // domains are set later via Team page
      emoji: tmEmoji,
      agentId: tmIsHuman ? '' : tmAgentId.trim(),
    }]);
    setTmName('');
    setTmTitle('');
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
            domain: '', // domains assigned later via Team page
            isHuman: tm.isHuman,
            agentId: tm.agentId || '',
            color: tm.isHuman ? 'amber' : 'cyan',
            description: '',
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
      <div className="inline-flex items-center justify-center w-20 h-20 rounded-3xl bg-[var(--accent-muted)] mb-8">
        <Rocket size={40} className="text-[var(--accent-primary)]" />
      </div>
      <h1 className="text-[var(--text-4xl)] font-bold text-[var(--text-primary)] mb-4 tracking-tight">
        Stop assigning tasks to your AI agents.
      </h1>
      <p className="text-[var(--text-lg)] text-[var(--text-secondary)] mb-12 leading-relaxed">
        Give them a mission, domain boundaries, and a feedback loop — they'll figure out the rest.
      </p>

      <div className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-lg)] p-8 space-y-4 text-left mb-10">
        <div className="flex gap-3">
          <span className="text-2xl shrink-0">📋</span>
          <div>
            <p className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">Define your organization</p>
            <p className="text-[var(--text-xs)] text-[var(--text-tertiary)] mt-0.5">Mission, team structure, and who owns what</p>
          </div>
        </div>
        <div className="flex gap-3">
          <span className="text-2xl shrink-0">🎯</span>
          <div>
            <p className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">Create projects with vision</p>
            <p className="text-[var(--text-xs)] text-[var(--text-tertiary)] mt-0.5">Agents will propose roadmaps and ship autonomously</p>
          </div>
        </div>
        <div className="flex gap-3">
          <span className="text-2xl shrink-0">🔄</span>
          <div>
            <p className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">Get feedback loops</p>
            <p className="text-[var(--text-xs)] text-[var(--text-tertiary)] mt-0.5">Review, approve, and agents iterate until shipped</p>
          </div>
        </div>
      </div>

      <p className="text-[var(--text-xs)] text-[var(--text-muted)] mb-3">
        Let's set up your team. It takes 3 minutes.
      </p>
    </div>
  );

  const renderStep1 = () => (
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

  const renderStep2 = () => (
    <div className="max-w-xl mx-auto">
      <div className="text-center mb-10">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-[var(--info-subtle)] mb-6">
          <Wifi size={28} className="text-[var(--info)]" />
        </div>
        <h1 className="text-[var(--text-3xl)] font-bold text-[var(--text-primary)] mb-3 tracking-tight">
          Connect Your Agent Runtime
        </h1>
        <p className="text-[var(--text-md)] text-[var(--text-tertiary)] leading-relaxed">
          Org Studio can auto-detect agents from OpenClaw and Hermes Agent. Skip this if you're running standalone.
        </p>
      </div>

      <div className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-lg)] p-6 space-y-5">
        <div>
          <div className="flex items-center gap-3 mb-4">
            <button
              onClick={pollRuntimes}
              disabled={gatewayLoading}
              className="flex items-center gap-2 px-4 py-2.5 rounded-[var(--radius-md)] text-[var(--text-sm)] font-medium transition-all bg-[var(--accent-primary)] text-white hover:bg-[var(--accent-hover)] disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {gatewayLoading ? (
                <>
                  <Loader size={14} className="animate-spin" /> Detecting...
                </>
              ) : (
                <>
                  <Wifi size={14} /> Detect Runtimes
                </>
              )}
            </button>
          </div>

          {runtimes.length > 0 ? (
            <div className="space-y-4">
              {runtimes.map((runtime) => (
                <div
                  key={runtime.id}
                  className="border border-[var(--border-default)] rounded-[var(--radius-md)] p-4 bg-[var(--bg-primary)]"
                >
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="text-lg">{runtime.id === 'hermes' ? '🧠' : '⚡'}</span>
                      <div>
                        <p className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">{runtime.name}</p>
                        {runtime.detail && (
                          <p className="text-[var(--text-xs)] text-[var(--text-muted)]">{runtime.detail}</p>
                        )}
                      </div>
                    </div>
                    <span
                      className={`text-[var(--text-xs)] font-medium px-2 py-1 rounded-full ${
                        runtime.connected
                          ? 'bg-[var(--success-subtle)] text-[var(--success)]'
                          : 'bg-[var(--warning-subtle)] text-[var(--warning)]'
                      }`}
                    >
                      {runtime.connected ? '● Connected' : '○ Not found'}
                    </span>
                  </div>

                  {runtime.connected && runtime.agents?.length > 0 ? (
                    <div className="space-y-2 mt-3 pt-3 border-t border-[var(--border-default)]">
                      {runtime.agents.map((agent: any) => (
                        <div key={agent.id} className="flex items-center gap-2 text-[var(--text-sm)]">
                          <span className="text-base">{agent.emoji || '🤖'}</span>
                          <span className="text-[var(--text-primary)] font-medium flex-1">{agent.name || agent.id}</span>
                          <span className="text-[var(--text-xs)] text-[var(--text-muted)] font-mono truncate max-w-[120px]">({agent.id})</span>
                        </div>
                      ))}
                    </div>
                  ) : runtime.connected ? (
                    <p className="text-[var(--text-xs)] text-[var(--text-muted)] mt-3 pt-3 border-t border-[var(--border-default)]">No agents found</p>
                  ) : null}
                </div>
              ))}
              <p className="text-[var(--text-xs)] text-[var(--text-muted)] mt-3">
                Agents from all connected runtimes will appear in your team roster. You can also add humans manually in the next step.
              </p>
            </div>
          ) : !gatewayLoading ? (
            <div className="bg-[var(--info-subtle)] border border-[var(--info-subtle)] rounded-[var(--radius-md)] p-3">
              <p className="text-[var(--text-sm)] text-[var(--text-primary)] font-medium">Click "Detect Runtimes" to find agent services</p>
            </div>
          ) : null}
        </div>

        <div>
          <p className="text-[var(--text-xs)] font-medium text-[var(--text-tertiary)] uppercase tracking-wider mb-2">
            Runtime Status
          </p>
          <div className="space-y-2 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-[var(--radius-md)] px-3 py-2.5 font-mono text-[var(--text-xs)] text-[var(--text-muted)]">
            {runtimes.length > 0 ? (
              runtimes.map((r) => (
                <div key={r.id}>
                  {r.id}: {r.connected ? '✓ Connected' : '✗ Not found'}
                </div>
              ))
            ) : (
              <div>No runtime data — click "Detect Runtimes" above</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  const renderStep3 = () => (
    <div className="max-w-xl mx-auto">
      <div className="text-center mb-10">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-[var(--accent-2-subtle)] mb-6">
          <Users size={28} className="text-[var(--accent-2)]" />
        </div>
        <h1 className="text-[var(--text-3xl)] font-bold text-[var(--text-primary)] mb-3 tracking-tight">
          {detectedAgents.length > 0 ? 'Add Team Members' : 'Build Your Team'}
        </h1>
        <p className="text-[var(--text-md)] text-[var(--text-tertiary)] leading-relaxed">
          {detectedAgents.length > 0
            ? `We found ${detectedAgents.length} agent${detectedAgents.length !== 1 ? 's' : ''}. Add any humans here.`
            : 'Add the people on your team. You can add agents later.'
          }
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
          <Plus size={15} /> Add Person
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
                  {tm.title || 'Team member'}
                </p>
              </div>
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

        {!orgName.trim() && detectedAgents.length === 0 && teammates.length === 0 && (
          <p className="text-[var(--text-sm)] text-[var(--text-muted)] text-center py-4">
            No worries — you can set everything up from the dashboard. Let's go!
          </p>
        )}
      </div>

      <div className="bg-[var(--info-subtle)] border border-[var(--info-subtle)] rounded-[var(--radius-lg)] p-5 mb-8 text-left space-y-3">
        <p className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">Next steps:</p>
        <div className="space-y-2 text-[var(--text-xs)] text-[var(--text-secondary)]">
          <p>1. <strong>Create your first project</strong> with a vision doc (North Star, boundaries, aspirations)</p>
          <p>2. <strong>Set domain ownership</strong> on the Team page — assign projects to agents and humans</p>
          <p>3. <strong>Let agents propose</strong> a roadmap — then review and approve versions</p>
          <p>4. <strong>Watch them ship</strong> — agents work autonomously, you review + iterate</p>
        </div>
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
      <div className="sticky top-0 bg-[var(--bg-primary)] border-b border-[var(--border-default)] px-6 py-3 flex items-center justify-between">
        <div />
        <button
          onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
          className="p-2 rounded-[var(--radius-md)] hover:bg-[var(--bg-secondary)] transition-colors text-[var(--text-secondary)]"
          title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
        >
          {theme === 'light' ? '🌙' : '☀️'}
        </button>
      </div>

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

      {step < 5 && step > 0 && (
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
              Continue <ArrowRight size={15} />
            </button>
          </div>
        </div>
      )}

      {step === 0 && (
        <div className="sticky bottom-0 bg-[var(--bg-primary)] border-t border-[var(--border-default)] px-6 py-4">
          <div className="max-w-lg mx-auto flex justify-center">
            <button
              onClick={next}
              className="flex items-center gap-2 px-8 py-3 rounded-[var(--radius-md)] text-[var(--text-base)] font-semibold transition-all bg-[var(--accent-primary)] text-white hover:bg-[var(--accent-hover)] shadow-[var(--shadow-glow)]"
            >
              Let's set up your team <ArrowRight size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
