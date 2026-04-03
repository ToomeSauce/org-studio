'use client';

import { useState, useRef, useCallback } from 'react';
import { clsx } from 'clsx';
import { X, Upload, Plus, UserPlus } from 'lucide-react';
import { COLOR_KEYS, COLOR_MAP, resolveColor } from '@/lib/teammates';

// Common emoji options for quick selection
const EMOJI_OPTIONS = [
  '🤖', '⚡', '🔬', '🧄', '⚖️', '💡', '🧠', '🎯',
  '🦊', '🐱', '🐶', '🦉', '🐝', '🐙', '🦈', '🐺',
  '🚀', '🔧', '💎', '🎨', '📊', '🔮', '🛡️', '⚙️',
  '👤', '👩‍💻', '👨‍💼', '🧑‍🔬', '🧑‍⚕️', '🧑‍🎓', '🧑‍🔧', '🧑‍💻',
];

interface EmojiAvatarPickerProps {
  currentEmoji: string;
  currentAvatar?: string;
  onSelect: (update: { emoji?: string; avatar?: string }) => void;
  onClose: () => void;
}

export function EmojiAvatarPicker({ currentEmoji, currentAvatar, onSelect, onClose }: EmojiAvatarPickerProps) {
  const [customEmoji, setCustomEmoji] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 512_000) { alert('Image must be under 500KB'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      onSelect({ avatar: reader.result as string, emoji: currentEmoji });
      onClose();
    };
    reader.readAsDataURL(file);
  }, [currentEmoji, onSelect, onClose]);

  return (
    <div onClick={e => e.stopPropagation()} className="absolute z-50 top-full left-0 mt-2 bg-[var(--card)] border border-[var(--border-strong)] rounded-[var(--radius-lg)] p-4 shadow-lg w-[280px]">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[var(--text-xs)] font-semibold text-[var(--text-muted)] uppercase tracking-wide">Choose Avatar</span>
        <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={14} /></button>
      </div>

      {/* Emoji grid */}
      <div className="grid grid-cols-8 gap-1 mb-3">
        {EMOJI_OPTIONS.map(e => (
          <button
            key={e}
            onClick={() => { onSelect({ emoji: e, avatar: undefined }); onClose(); }}
            className={clsx(
              'w-8 h-8 flex items-center justify-center rounded-[var(--radius-sm)] text-lg hover:bg-[var(--bg-tertiary)] transition-colors',
              e === currentEmoji && !currentAvatar && 'bg-[var(--bg-tertiary)] ring-1 ring-[var(--accent-primary)]'
            )}
          >
            {e}
          </button>
        ))}
      </div>

      {/* Custom emoji input */}
      <div className="flex gap-2 mb-3">
        <input
          value={customEmoji}
          onChange={e => setCustomEmoji(e.target.value)}
          placeholder="Type any emoji…"
          maxLength={4}
          className="flex-1 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] px-2 py-1.5 text-center text-lg focus:outline-none focus:border-[var(--accent-primary)]"
        />
        <button
          onClick={() => { if (customEmoji.trim()) { onSelect({ emoji: customEmoji.trim(), avatar: undefined }); onClose(); } }}
          disabled={!customEmoji.trim()}
          className="px-3 py-1.5 rounded-[var(--radius-sm)] bg-[var(--bg-tertiary)] text-[var(--text-xs)] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-40 transition-colors"
        >
          Set
        </button>
      </div>

      {/* Upload image */}
      <button
        onClick={() => fileRef.current?.click()}
        className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-[var(--radius-sm)] border border-dashed border-[var(--border-default)] text-[var(--text-xs)] text-[var(--text-muted)] hover:border-[var(--accent-primary)] hover:text-[var(--text-primary)] transition-colors"
      >
        <Upload size={13} /> Upload image (max 500KB)
      </button>
      <input ref={fileRef} type="file" accept="image/*" onChange={handleFileUpload} className="hidden" />

      {/* Clear avatar if custom image set */}
      {currentAvatar && (
        <button
          onClick={() => { onSelect({ emoji: currentEmoji, avatar: undefined }); onClose(); }}
          className="w-full mt-2 text-center text-[var(--text-xs)] text-[var(--text-muted)] hover:text-[var(--accent-primary)] transition-colors"
        >
          Remove custom image → use emoji
        </button>
      )}
    </div>
  );
}

interface ColorPickerProps {
  current: string;
  onSelect: (color: string) => void;
}

export function ColorPicker({ current, onSelect }: ColorPickerProps) {
  return (
    <div className="flex gap-1.5 flex-wrap">
      {COLOR_KEYS.map(key => {
        const c = COLOR_MAP[key];
        return (
          <button
            key={key}
            onClick={() => onSelect(key)}
            className={clsx(
              'w-6 h-6 rounded-full transition-all',
              current === key ? 'ring-2 ring-[var(--text-primary)] ring-offset-2 ring-offset-[var(--card)] scale-110' : 'hover:scale-110'
            )}
            style={{ backgroundColor: c.glowRgba }}
            title={key}
          />
        );
      })}
    </div>
  );
}

interface AddTeammateCardProps {
  onAdd: (teammate: {
    name: string; emoji: string; avatar?: string; title: string;
    domain: string; owns: string; defers: string; description: string; color: string; isHuman: boolean; agentId: string;
  }) => void;
  gatewayConnected?: boolean;
}

export function AddTeammateCard({ onAdd, gatewayConnected }: AddTeammateCardProps) {
  const [open, setOpen] = useState(false);
  const defaultHuman = gatewayConnected || false;
  const [draft, setDraft] = useState({
    name: '', emoji: defaultHuman ? '👤' : '🤖', avatar: undefined as string | undefined,
    title: '', domain: '', owns: '', defers: '', description: '', color: 'blue', isHuman: defaultHuman, agentId: '',
  });
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);

  const reset = () => {
    setDraft({ name: '', emoji: defaultHuman ? '👤' : '🤖', avatar: undefined, title: '', domain: '', owns: '', defers: '', description: '', color: 'blue', isHuman: defaultHuman, agentId: '' });
    setOpen(false);
    setShowEmojiPicker(false);
  };

  const submit = () => {
    if (!draft.name.trim()) return;
    onAdd({
      ...draft,
      isHuman: gatewayConnected ? true : draft.isHuman,
      agentId: gatewayConnected ? '' : draft.agentId.trim(),
      name: draft.name.trim(),
      title: draft.title.trim() || 'Team Member',
      domain: draft.domain.trim() || 'General',
      description: draft.description.trim(),
    });
    reset();
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="bg-[var(--card)] border border-dashed border-[var(--border-default)] rounded-[var(--radius-lg)] p-5 flex items-center justify-center gap-3 text-[var(--text-muted)] hover:border-[var(--accent-primary)] hover:text-[var(--text-primary)] transition-all min-h-[140px] cursor-pointer"
      >
        <UserPlus size={20} />
        <span className="text-[var(--text-sm)] font-medium">{gatewayConnected ? 'Add Human' : 'Add Teammate'}</span>
      </button>
    );
  }

  const colors = resolveColor(draft.color);

  return (
    <div className="bg-[var(--card)] border border-[var(--accent-primary)] rounded-[var(--radius-lg)] p-5 shadow-[var(--shadow-sm)]">
      <div className="flex items-start gap-4">
        {/* Avatar/emoji selector */}
        <div className="relative">
          <button
            onClick={() => setShowEmojiPicker(!showEmojiPicker)}
            className={clsx(
              'w-12 h-12 rounded-full flex items-center justify-center text-xl shrink-0 cursor-pointer hover:ring-2 hover:ring-[var(--accent-primary)] transition-all overflow-hidden',
              colors.bg,
            )}
          >
            {draft.avatar
              ? <img src={draft.avatar} alt="" className="w-full h-full object-cover rounded-full" />
              : draft.emoji}
          </button>
          {showEmojiPicker && (
            <EmojiAvatarPicker
              currentEmoji={draft.emoji}
              currentAvatar={draft.avatar}
              onSelect={u => setDraft(d => ({ ...d, emoji: u.emoji || d.emoji, avatar: u.avatar }))}
              onClose={() => setShowEmojiPicker(false)}
            />
          )}
        </div>

        <div className="flex-1 space-y-2.5">
          {/* Name */}
          <input
            value={draft.name}
            onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
            placeholder="Name"
            autoFocus
            className="w-full bg-[var(--bg-secondary)] border border-[var(--border-strong)] rounded-[var(--radius-sm)] px-2 py-1.5 text-[var(--text-sm)] text-[var(--text-primary)] font-bold focus:outline-none focus:border-[var(--accent-primary)]"
          />

          {/* Agent type toggle — only when no Gateway (standalone mode) */}
          {!gatewayConnected && (
            <>
              <div className="flex gap-2">
                <button
                  onClick={() => setDraft(d => ({ ...d, isHuman: !d.isHuman, emoji: d.isHuman ? '🤖' : '👤' }))}
                  className={clsx(
                    'px-3 py-1.5 rounded-[var(--radius-sm)] text-[var(--text-xs)] font-medium border transition-colors',
                    draft.isHuman
                      ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
                      : 'border-cyan-500/30 bg-cyan-500/10 text-cyan-400'
                  )}
                >
                  {draft.isHuman ? '👤 Human' : '🤖 Agent'}
                </button>
              </div>
              {!draft.isHuman && (
                <input
                  value={draft.agentId}
                  onChange={e => setDraft(d => ({ ...d, agentId: e.target.value }))}
                  placeholder="Agent ID (e.g. 'ana')"
                  className="w-full bg-[var(--bg-secondary)] border border-[var(--border-strong)] rounded-[var(--radius-sm)] px-2 py-1.5 text-[var(--text-xs)] text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)]"
                />
              )}
            </>
          )}

          {/* Domain + Title */}
          <input
            value={draft.domain}
            onChange={e => setDraft(d => ({ ...d, domain: e.target.value }))}
            placeholder="Domain (e.g. 'Engineering')"
            className="w-full bg-[var(--bg-secondary)] border border-[var(--border-strong)] rounded-[var(--radius-sm)] px-2 py-1.5 text-[var(--text-sm)] text-[var(--text-primary)] font-bold focus:outline-none focus:border-[var(--accent-primary)]"
          />
          <input
            value={draft.title}
            onChange={e => setDraft(d => ({ ...d, title: e.target.value }))}
            placeholder="Title (e.g. 'Senior Engineer')"
            className="w-full bg-[var(--bg-secondary)] border border-[var(--border-strong)] rounded-[var(--radius-sm)] px-2 py-1.5 text-[var(--text-xs)] text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)]"
          />
          <div>
            <label className="text-[var(--text-xs)] font-semibold text-[var(--success)] mb-1 block">✅ Owns — autonomous decisions</label>
            <textarea
              value={draft.owns}
              onChange={e => setDraft(d => ({ ...d, owns: e.target.value }))}
              placeholder="Architecture decisions, CI/CD, staging deploys..."
              rows={2}
              className="w-full bg-[var(--bg-secondary)] border border-[var(--border-strong)] rounded-[var(--radius-sm)] px-2 py-1.5 text-[var(--text-xs)] text-[var(--text-tertiary)] leading-relaxed resize-none focus:outline-none focus:border-[var(--accent-primary)]"
            />
          </div>
          <div>
            <label className="text-[var(--text-xs)] font-semibold text-amber-400 mb-1 block">🛑 Defers — needs confirmation</label>
            <textarea
              value={draft.defers}
              onChange={e => setDraft(d => ({ ...d, defers: e.target.value }))}
              placeholder="Production deploys, budget, customer-facing changes..."
              rows={2}
              className="w-full bg-[var(--bg-secondary)] border border-[var(--border-strong)] rounded-[var(--radius-sm)] px-2 py-1.5 text-[var(--text-xs)] text-[var(--text-tertiary)] leading-relaxed resize-none focus:outline-none focus:border-[var(--accent-primary)]"
            />
          </div>
          <textarea
            value={draft.description}
            onChange={e => setDraft(d => ({ ...d, description: e.target.value }))}
            placeholder="Description (optional)"
            rows={2}
            className="w-full bg-[var(--bg-secondary)] border border-[var(--border-strong)] rounded-[var(--radius-sm)] px-2 py-1.5 text-[var(--text-xs)] text-[var(--text-tertiary)] leading-relaxed resize-none focus:outline-none focus:border-[var(--accent-primary)]"
          />

          {/* Color picker */}
          <div>
            <span className="text-[var(--text-xs)] text-[var(--text-muted)] mb-1.5 block">Color</span>
            <ColorPicker current={draft.color} onSelect={c => setDraft(d => ({ ...d, color: c }))} />
          </div>

          {/* Actions */}
          <div className="flex gap-2 pt-1">
            <button
              onClick={submit}
              disabled={!draft.name.trim()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] bg-[var(--success-subtle)] text-[var(--success)] text-[var(--text-xs)] font-medium hover:bg-[var(--success)] hover:text-white transition-colors disabled:opacity-40"
            >
              <Plus size={12} /> Add
            </button>
            <button
              onClick={reset}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] bg-[var(--bg-tertiary)] text-[var(--text-muted)] text-[var(--text-xs)] font-medium hover:text-[var(--text-primary)] transition-colors"
            >
              <X size={12} /> Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
