import { Pencil, Check, X, Trash2, Unplug, RefreshCw, Award } from 'lucide-react';
import { useState, useEffect } from 'react';
import { clsx } from 'clsx';

interface DeliveryStats {
  agentId: string;
  period: string;
  tasksCompleted: number;
  avgCycleTimeMs: number;
  avgCycleTimeHuman: string;
  firstPassRate: number;
  qaBounces: number;
  currentStreak: number;
  kudosCount: number;
  flagsCount: number;
  topValue: string | null;
  tasksInProgress: number;
  tasksInBacklog: number;
}

export function PersonCardStats({ 
  agentId, 
  isHuman,
  onGiveKudos 
}: { 
  agentId: string; 
  isHuman?: boolean;
  onGiveKudos?: () => void;
}) {
  const [stats, setStats] = useState<DeliveryStats | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isHuman || !agentId) return;
    
    async function load() {
      setLoading(true);
      try {
        const res = await fetch(`/api/stats/${agentId}`);
        const data = await res.json();
        setStats(data);
      } catch (err) {
        console.error(`Failed to load stats for ${agentId}:`, err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [agentId, isHuman]);

  if (isHuman || !stats) return null;

  return (
    <div className="mt-3 pt-3 border-t border-[var(--border-default)] space-y-2 text-[var(--text-xs)]">
      <div className="flex items-center justify-between">
        <span className="text-[var(--text-muted)]">📊 30-day Performance</span>
        {onGiveKudos && (
          <button
            onClick={onGiveKudos}
            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] bg-amber-500/10 text-amber-500 hover:bg-amber-500/20 transition-colors"
            title="Give kudos or flag"
          >
            <Award size={10} /> Kudos
          </button>
        )}
      </div>
      
      <div className="space-y-1 font-mono text-[10px] text-[var(--text-tertiary)]">
        <div className="flex justify-between">
          <span>Tasks:</span>
          <span className="font-semibold text-[var(--text-primary)]">
            {stats.tasksCompleted} done • {stats.tasksInProgress} in-progress
          </span>
        </div>
        <div className="flex justify-between">
          <span>Cycle:</span>
          <span className="font-semibold text-[var(--text-primary)]">
            ~{stats.avgCycleTimeHuman}
          </span>
        </div>
        <div className="flex justify-between">
          <span>Quality:</span>
          <span className="font-semibold text-[var(--text-primary)]">
            {Math.round(stats.firstPassRate * 100)}% first-pass
          </span>
        </div>
        {stats.currentStreak > 0 && (
          <div className="flex justify-between">
            <span>Streak:</span>
            <span className="font-semibold text-emerald-400">
              {stats.currentStreak} 🔥
            </span>
          </div>
        )}
      </div>

      {(stats.kudosCount > 0 || stats.flagsCount > 0) && (
        <div className="flex gap-2 pt-1 border-t border-[var(--border-default)]">
          {stats.kudosCount > 0 && (
            <span className="text-emerald-400">
              ⭐ {stats.kudosCount}
              {stats.topValue && ` (${stats.topValue})`}
            </span>
          )}
          {stats.flagsCount > 0 && (
            <span className="text-amber-400">
              🚩 {stats.flagsCount}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
