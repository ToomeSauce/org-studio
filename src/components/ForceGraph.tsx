'use client';

import { useRef, useState, useEffect, useCallback } from 'react';
import { clsx } from 'clsx';
import { X } from 'lucide-react';
import { Teammate, resolveColor } from '@/lib/teammates';

interface Node {
  id: string;
  name: string;
  emoji: string;
  domain: string;
  color: string;
  glowColor: string;
  bgColor: string;
  size: number;
  mass: number;
  fixed?: boolean;
  isHuman?: boolean;
  idleSpeed: number;
  activeSpeed: number;
  orbitDir: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface Edge {
  from: string;
  to: string;
  label: string;
  strength: number;
  restLength: number;
}

function buildInitialNodes(teammates: Teammate[]): Omit<Node, 'x' | 'y' | 'vx' | 'vy'>[] {
  const mission: Omit<Node, 'x' | 'y' | 'vx' | 'vy'> = {
    id: 'mission', name: 'Mission', emoji: '🎯', domain: 'The Nucleus',
    color: 'text-[var(--accent-primary)]', glowColor: 'rgba(255,92,92,0.5)', bgColor: 'rgba(255,92,92,0.2)',
    size: 80, mass: 10, fixed: true, idleSpeed: 0, activeSpeed: 0, orbitDir: 1,
  };
  const nodes = teammates.map((t, i) => {
    const c = resolveColor(t.color);
    const isHuman = t.isHuman || false;
    return {
      id: t.agentId || t.id,
      name: t.name,
      emoji: t.emoji,
      domain: t.domain,
      color: c.text,
      glowColor: c.glowRgba,
      bgColor: c.bgRgba,
      size: isHuman ? 56 : 64,
      mass: isHuman ? 3 : 2,
      isHuman,
      idleSpeed: isHuman ? 0.3 : 0.2,
      activeSpeed: isHuman ? 0.3 : 0.8,
      orbitDir: i % 2 === 0 ? 1 : -1 as number,
    };
  });
  return [mission, ...nodes];
}

function buildEdges(teammates: Teammate[]): Edge[] {
  return teammates.map(t => ({
    from: 'mission',
    to: t.agentId || t.id,
    label: '',
    strength: t.isHuman ? 0.02 : 0.01,
    restLength: t.isHuman ? 130 : 220,
  }));
}

function initNodes(initialNodes: Omit<Node, 'x' | 'y' | 'vx' | 'vy'>[], width: number, height: number): Node[] {
  const cx = width / 2;
  const cy = height / 2;
  return initialNodes.map((n, i) => {
    if (n.fixed) return { ...n, x: cx, y: cy, vx: 0, vy: 0 };
    const angle = ((i - 1) / (initialNodes.length - 1)) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
    const r = 150 + Math.random() * 60;
    return {
      ...n,
      x: cx + Math.cos(angle) * r,
      y: cy + Math.sin(angle) * r,
      vx: (Math.random() - 0.5) * 1,
      vy: (Math.random() - 0.5) * 1,
    };
  });
}

/* ── Settings panel for a node ── */
function NodeSettings({
  node,
  onChange,
  onClose,
}: {
  node: Node;
  onChange: (updates: Partial<Pick<Node, 'mass' | 'idleSpeed' | 'activeSpeed' | 'orbitDir' | 'size' | 'domain'>>) => void;
  onClose: () => void;
}) {
  const [domainDraft, setDomainDraft] = useState(node.domain);

  return (
    <div
      className="absolute bg-[var(--card)] border border-[var(--border-strong)] rounded-[var(--radius-lg)] p-4 shadow-[var(--shadow-lg)] w-56"
      style={{ zIndex: 300 }}
      onPointerDown={e => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-base">{node.emoji}</span>
          <span className={clsx('text-[var(--text-sm)] font-bold', node.color)}>{node.name}</span>
        </div>
        <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
          <X size={14} />
        </button>
      </div>

      {/* Domain */}
      <label className="block mb-3">
        <span className="text-[var(--text-xs)] text-[var(--text-muted)] block mb-1">Domain</span>
        <input
          type="text" value={domainDraft}
          onChange={e => setDomainDraft(e.target.value)}
          onBlur={() => { if (domainDraft !== node.domain) onChange({ domain: domainDraft }); }}
          onKeyDown={e => { if (e.key === 'Enter') { onChange({ domain: domainDraft }); (e.target as HTMLInputElement).blur(); } }}
          className="w-full bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-[var(--radius-sm)] px-2 py-1 text-[var(--text-xs)] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
        />
      </label>

      {/* Mass */}
      <label className="block mb-3">
        <div className="flex justify-between mb-1">
          <span className="text-[var(--text-xs)] text-[var(--text-muted)]">Mass</span>
          <span className="text-[var(--text-xs)] font-mono text-[var(--text-tertiary)]">{node.mass.toFixed(1)}</span>
        </div>
        <input
          type="range" min="0.5" max="8" step="0.5" value={node.mass}
          onChange={e => onChange({ mass: parseFloat(e.target.value) })}
          className="w-full accent-[var(--accent-primary)] h-1"
        />
      </label>

      {/* Idle Speed */}
      <label className="block mb-3">
        <div className="flex justify-between mb-1">
          <span className="text-[var(--text-xs)] text-[var(--text-muted)]">Idle Speed</span>
          <span className="text-[var(--text-xs)] font-mono text-[var(--text-tertiary)]">{node.idleSpeed.toFixed(1)}</span>
        </div>
        <input
          type="range" min="0" max="3" step="0.1" value={node.idleSpeed}
          onChange={e => onChange({ idleSpeed: parseFloat(e.target.value) })}
          className="w-full accent-[var(--accent-primary)] h-1"
        />
      </label>

      {/* Active Speed */}
      <label className="block mb-3">
        <div className="flex justify-between mb-1">
          <span className="text-[var(--text-xs)] text-[var(--text-muted)]">Active Speed</span>
          <span className="text-[var(--text-xs)] font-mono text-[var(--text-tertiary)]">{node.activeSpeed.toFixed(1)}</span>
        </div>
        <input
          type="range" min="0" max="3" step="0.1" value={node.activeSpeed}
          onChange={e => onChange({ activeSpeed: parseFloat(e.target.value) })}
          className="w-full accent-[var(--accent-primary)] h-1"
        />
      </label>

      {/* Size */}
      <label className="block mb-3">
        <div className="flex justify-between mb-1">
          <span className="text-[var(--text-xs)] text-[var(--text-muted)]">Size</span>
          <span className="text-[var(--text-xs)] font-mono text-[var(--text-tertiary)]">{node.size}px</span>
        </div>
        <input
          type="range" min="40" max="100" step="4" value={node.size}
          onChange={e => onChange({ size: parseInt(e.target.value) })}
          className="w-full accent-[var(--accent-primary)] h-1"
        />
      </label>

      {/* Direction */}
      <div className="flex items-center justify-between">
        <span className="text-[var(--text-xs)] text-[var(--text-muted)]">Direction</span>
        <button
          onClick={() => onChange({ orbitDir: node.orbitDir * -1 })}
          className="text-[var(--text-xs)] font-medium px-2 py-1 rounded-[var(--radius-sm)] bg-[var(--bg-secondary)] border border-[var(--border-default)] hover:border-[var(--border-strong)] transition-colors"
        >
          {node.orbitDir === 1 ? '↻ CW' : '↺ CCW'}
        </button>
      </div>
    </div>
  );
}

export function ForceGraph({
  activeAgentIds,
  activityStatuses,
  savedNodePhysics,
  teammates,
}: {
  activeAgentIds: Set<string>;
  activityStatuses: Record<string, any>;
  savedNodePhysics?: Record<string, any>;
  teammates: Teammate[];
}) {
  const initialNodesRef = useRef<Omit<Node, 'x' | 'y' | 'vx' | 'vy'>[]>([]);
  const edgesRef = useRef<Edge[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const nodesRef = useRef<Node[]>([]);
  const [renderNodes, setRenderNodes] = useState<Node[]>([]);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const dragRef = useRef<{ nodeId: string; offsetX: number; offsetY: number; moved: boolean } | null>(null);
  const sizeRef = useRef({ width: 800, height: 496 });
  const activeRef = useRef<Set<string>>(activeAgentIds);
  activeRef.current = activeAgentIds;
  selectedRef.current = selectedNode;
  const manualOverrides = useRef<Set<string>>(new Set());
  const animRef = useRef<number>(0);

  // Rebuild node/edge definitions when teammates change
  const teammateKey = teammates.map(t => t.id).join(',');
  useEffect(() => {
    initialNodesRef.current = buildInitialNodes(teammates);
    edgesRef.current = buildEdges(teammates);
  }, [teammateKey]);

  // Initialize (or re-init when teammates arrive for the first time)
  const initDone = useRef(false);
  useEffect(() => {
    const el = containerRef.current;
    if (!el || teammates.length === 0) return;
    const expectedCount = initialNodesRef.current.length;
    if (!initDone.current || nodesRef.current.length <= 1 || nodesRef.current.length !== expectedCount) {
      // First mount, teammates just arrived, or teammate count changed
      const rect = el.getBoundingClientRect();
      sizeRef.current = { width: rect.width, height: 496 };
      nodesRef.current = initNodes(initialNodesRef.current, rect.width, 496);
      initDone.current = true;
    }
    // Apply saved physics whenever they arrive or change
    if (savedNodePhysics) {
      for (const n of nodesRef.current) {
        const saved = savedNodePhysics[n.id];
        if (saved) {
          if (saved.mass != null) n.mass = saved.mass;
          if (saved.idleSpeed != null) n.idleSpeed = saved.idleSpeed;
          if (saved.activeSpeed != null) n.activeSpeed = saved.activeSpeed;
          if (saved.orbitDir != null) n.orbitDir = saved.orbitDir;
          if (saved.size != null) n.size = saved.size;
          if (saved.domain != null) n.domain = saved.domain;
        }
      }
    }
    setRenderNodes([...nodesRef.current]);
  }, [savedNodePhysics, teammateKey]);

  // Physics loop
  useEffect(() => {
    let running = true;
    let lastTime = 0;

    const step = (timestamp: number) => {
      if (!running) return;
      if (!lastTime) lastTime = timestamp;
      const rawDt = (timestamp - lastTime) / 1000;
      const dt = Math.min(rawDt, 0.033);
      lastTime = timestamp;

      const nodes = nodesRef.current;
      const { width, height } = sizeRef.current;
      if (nodes.length === 0) { animRef.current = requestAnimationFrame(step); return; }

      // Gravity toward center
      for (const n of nodes) {
        if (n.fixed || dragRef.current?.nodeId === n.id || selectedRef.current === n.id) continue;
        const cx = width / 2;
        const cy = height / 2;
        const dx = cx - n.x;
        const dy = cy - n.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        n.vx += (dx / dist) * 0.3 * dt;
        n.vy += (dy / dist) * 0.3 * dt;
      }

      // Node-node repulsion + collision
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const minDist = (a.size + b.size) / 2 + 40;

          // Repulsion
          const repulsion = 15000 / (dist * dist);
          const fx = (dx / dist) * repulsion * dt;
          const fy = (dy / dist) * repulsion * dt;

          if (!a.fixed && dragRef.current?.nodeId !== a.id && selectedRef.current !== a.id) {
            a.vx -= fx / a.mass;
            a.vy -= fy / a.mass;
          }
          if (!b.fixed && dragRef.current?.nodeId !== b.id && selectedRef.current !== b.id) {
            b.vx += fx / b.mass;
            b.vy += fy / b.mass;
          }

          // Hard collision with elastic bounce + direction reversal
          if (dist < minDist) {
            const overlap = (minDist - dist) / 2 + 2;
            const nx = dx / dist;
            const ny = dy / dist;

            if (!a.fixed && dragRef.current?.nodeId !== a.id && selectedRef.current !== a.id) {
              a.x -= nx * overlap;
              a.y -= ny * overlap;
            }
            if (!b.fixed && dragRef.current?.nodeId !== b.id && selectedRef.current !== b.id) {
              b.x += nx * overlap;
              b.y += ny * overlap;
            }

            const relVx = a.vx - b.vx;
            const relVy = a.vy - b.vy;
            const relDot = relVx * nx + relVy * ny;
            if (relDot > 0) {
              const restitution = 0.8;
              const totalMass = a.mass + b.mass;
              const impulse = (1 + restitution) * relDot / totalMass;
              if (!a.fixed && dragRef.current?.nodeId !== a.id && selectedRef.current !== a.id) {
                a.vx -= impulse * b.mass * nx;
                a.vy -= impulse * b.mass * ny;
              }
              if (!b.fixed && dragRef.current?.nodeId !== b.id && selectedRef.current !== b.id) {
                b.vx += impulse * a.mass * nx;
                b.vy += impulse * a.mass * ny;
              }

              // Reverse orbit direction on collision
              if (!a.fixed) a.orbitDir *= -1;
              if (!b.fixed) b.orbitDir *= -1;
            }
          }
        }
      }

      // Edges are visual only — no spring forces

      // Integrate + damping + drift
      for (const n of nodes) {
        if (n.fixed || dragRef.current?.nodeId === n.id || selectedRef.current === n.id) continue;
        n.vx *= 0.94;
        n.vy *= 0.94;

        const isNodeActive = activeRef.current.has(n.id) || manualOverrides.current.has(n.id);
        const speed = isNodeActive ? n.activeSpeed : n.idleSpeed;
        if (speed > 0) {
          const cx = width / 2;
          const cy = height / 2;
          const dxc = n.x - cx;
          const dyc = n.y - cy;
          const orbitForce = 0.012 * speed * n.orbitDir;
          n.vx += -dyc * orbitForce * dt;
          n.vy += dxc * orbitForce * dt;

          const t = timestamp / 1000;
          const idx = nodes.indexOf(n);
          const wx = Math.sin(t * 0.3 + idx * 2.1) * 0.04 + Math.sin(t * 0.7 + idx * 4.3) * 0.02;
          const wy = Math.cos(t * 0.25 + idx * 1.7) * 0.04 + Math.cos(t * 0.6 + idx * 3.9) * 0.02;
          n.vx += wx;
          n.vy += wy;
        }

        n.x += n.vx;
        n.y += n.vy;

        // Max tether length: half the container height
        const maxTether = height / 2;
        const mission = nodes.find(nd => nd.fixed);
        if (mission) {
          const tdx = n.x - mission.x;
          const tdy = n.y - mission.y;
          const tDist = Math.sqrt(tdx * tdx + tdy * tdy);
          if (tDist > maxTether) {
            const scale = maxTether / tDist;
            n.x = mission.x + tdx * scale;
            n.y = mission.y + tdy * scale;
            // Reflect velocity inward
            const nx = tdx / tDist;
            const ny = tdy / tDist;
            const dot = n.vx * nx + n.vy * ny;
            if (dot > 0) {
              n.vx -= 2 * dot * nx * 0.5;
              n.vy -= 2 * dot * ny * 0.5;
            }
          }
        }

        const pad = n.size / 2 + 10;
        if (n.x < pad) { n.x = pad; n.vx *= -0.5; }
        if (n.x > width - pad) { n.x = width - pad; n.vx *= -0.5; }
        if (n.y < pad) { n.y = pad; n.vy *= -0.5; }
        if (n.y > height - pad) { n.y = height - pad; n.vy *= -0.5; }
      }

      setRenderNodes(nodes.map(n => ({ ...n })));
      animRef.current = requestAnimationFrame(step);
    };

    animRef.current = requestAnimationFrame(step);
    return () => { running = false; cancelAnimationFrame(animRef.current); };
  }, []);

  // Update node properties from settings panel + persist
  const handleNodeChange = useCallback((nodeId: string, updates: Partial<Pick<Node, 'mass' | 'idleSpeed' | 'activeSpeed' | 'orbitDir' | 'size' | 'domain'>>) => {
    const node = nodesRef.current.find(n => n.id === nodeId);
    if (!node) return;
    Object.assign(node, updates);
    manualOverrides.current.add(nodeId);

    // Persist to store
    const saved: Record<string, any> = {};
    for (const n of nodesRef.current) {
      if (n.fixed) continue;
      saved[n.id] = { mass: n.mass, idleSpeed: n.idleSpeed, activeSpeed: n.activeSpeed, orbitDir: n.orbitDir, size: n.size, domain: n.domain };
    }
    fetch('/api/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'updateSettings', settings: { nodePhysics: saved } }),
    });
  }, []);

  // Pointer handlers — track drag distance for click vs drag detection
  const handlePointerDown = useCallback((e: React.PointerEvent, nodeId: string) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const node = nodesRef.current.find(n => n.id === nodeId);
    if (!node || node.fixed) return;
    dragRef.current = {
      nodeId,
      offsetX: e.clientX - rect.left - node.x,
      offsetY: e.clientY - rect.top - node.y,
      moved: false,
    };
    node.vx = 0;
    node.vy = 0;
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const node = nodesRef.current.find(n => n.id === dragRef.current!.nodeId);
    if (!node) return;
    const newX = e.clientX - rect.left - dragRef.current.offsetX;
    const newY = e.clientY - rect.top - dragRef.current.offsetY;
    const dx = newX - node.x;
    const dy = newY - node.y;
    if (dx * dx + dy * dy > 16) dragRef.current.moved = true;
    node.x = newX;
    node.y = newY;
    node.vx = 0;
    node.vy = 0;
  }, []);

  const handlePointerUp = useCallback(() => {
    if (dragRef.current) {
      const { nodeId, moved } = dragRef.current;
      if (!moved) {
        // Click (not drag) — toggle settings panel
        setSelectedNode(prev => prev === nodeId ? null : nodeId);
      } else {
        const node = nodesRef.current.find(n => n.id === nodeId);
        if (node) {
          node.vx = (Math.random() - 0.5) * 2;
          node.vy = (Math.random() - 0.5) * 2;
        }
      }
    }
    dragRef.current = null;
  }, []);

  // Close settings when clicking empty space
  const handleContainerClick = useCallback((e: React.MouseEvent) => {
    if (e.target === containerRef.current) {
      setSelectedNode(null);
    }
  }, []);

  const getNode = (id: string) => renderNodes.find(n => n.id === id);

  return (
    <div
      ref={containerRef}
      className="force-graph-container relative w-full select-none overflow-hidden"
      style={{ height: 496 }}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      onClick={handleContainerClick}
    >
      {/* Edges with gradients */}
      <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ zIndex: 2 }}>
        <defs>
          {edgesRef.current.map((edge, i) => {
            const a = getNode(edge.from);
            const b = getNode(edge.to);
            if (!a || !b) return null;
            const isActive = activeAgentIds.has(edge.to) && edge.from === 'mission';
            const gradId = `grad-${i}`;
            // Extract RGB values from glowRgba for gradient
            const fromColor = a.glowColor.replace(/[\d.]+\)$/, '0.3)');
            const toColor = b.glowColor.replace(/[\d.]+\)$/, '0.5)');
            return (
              <linearGradient key={gradId} id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor={fromColor} />
                <stop offset="100%" stopColor={toColor} />
              </linearGradient>
            );
          })}
        </defs>
        {edgesRef.current.map((edge, i) => {
          const a = getNode(edge.from);
          const b = getNode(edge.to);
          if (!a || !b) return null;
          const isMissionEdge = edge.from === 'mission';
          const isHovered = hoveredNode && (edge.from === hoveredNode || edge.to === hoveredNode);
          const isActive = activeAgentIds.has(edge.to) && isMissionEdge;
          const gradId = `grad-${i}`;
          return (
            <g key={i}>
              {/* Main gradient line */}
              <line
                x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke={isHovered ? 'var(--edge-hover)' : `url(#${gradId})`}
                strokeWidth={isHovered ? 2.5 : isActive ? 2 : 1.5}
                strokeLinecap="round"
                style={{ transition: 'stroke-width 0.3s' }}
              />
              {/* Subtle animated dash for active connections */}
              {isActive && (
                <line
                  x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  stroke={b.glowColor.replace(/[\d.]+\)$/, '0.6)')}
                  strokeWidth={1}
                  strokeDasharray="6,6"
                  strokeLinecap="round"
                  style={{
                    animation: 'dash-animation 2s linear infinite',
                    opacity: 0.4,
                  }}
                />
              )}
            </g>
          );
        })}
      </svg>

      {/* Nodes */}
      {renderNodes.map(node => {
        const isActive = activeAgentIds.has(node.id);
        const status = activityStatuses[node.id];
        const isDragging = dragRef.current?.nodeId === node.id;
        const isHovered = hoveredNode === node.id;
        const isSelected = selectedNode === node.id;
        const isMission = node.id === 'mission';

        // Determine glow style based on state
        let glowStyle = '';
        if (isMission) {
          glowStyle = `0 0 50px ${node.glowColor}, 0 0 100px ${node.glowColor.replace(/[\d.]+\)$/, '0.15)')}`;
        } else if (isActive && !node.isHuman) {
          // Active agents: pulsing glow (2.5s cycle)
          glowStyle = `0 0 24px ${node.glowColor}, 0 0 0 2px ${node.glowColor.replace(/[\d.]+\)$/, '0.5)')}`;
        } else if (node.isHuman) {
          // Humans: warm gold glow (always on)
          const warmGold = 'rgba(251, 191, 36, 0.3)';
          glowStyle = `0 0 16px ${warmGold}, 0 0 0 1.5px ${warmGold.replace(/[\d.]+\)$/, '0.4)')}`;
        } else {
          // Idle agents: softer static glow
          glowStyle = `0 0 12px ${node.glowColor.replace(/[\d.]+\)$/, '0.25)')}, 0 0 0 1px ${node.glowColor.replace(/[\d.]+\)$/, '0.15)')}`;
        }

        return (
          <div
            key={node.id}
            className={clsx(
              'absolute flex items-center justify-center rounded-full transition-all',
              !isMission && 'cursor-grab active:cursor-grabbing',
              isDragging && 'cursor-grabbing',
              !isMission && !isDragging && isActive && !node.isHuman && 'animate-pulse-glow',
            )}
            style={{
              width: node.size,
              height: node.size,
              left: node.x - node.size / 2,
              top: node.y - node.size / 2,
              zIndex: isDragging ? 50 : isSelected ? 45 : isHovered ? 40 : isMission ? 0 : 10,
              background: isMission
                ? `radial-gradient(circle, ${node.bgColor} 0%, transparent 70%)`
                : node.bgColor,
              boxShadow: glowStyle,
              border: isMission ? 'none' : `2px solid ${node.glowColor.replace(/[\d.]+\)$/, isSelected ? '0.6)' : isActive ? '0.4)' : '0.25)')}`,
              transform: isDragging
                ? 'scale(1.2)'
                : isHovered
                  ? 'scale(1.1)'
                  : 'scale(1)',
              transition: isDragging ? 'none' : 'transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.3s ease-out',
            }}
            onPointerDown={isMission ? undefined : (e) => handlePointerDown(e, node.id)}
            onPointerEnter={() => setHoveredNode(node.id)}
            onPointerLeave={() => setHoveredNode(null)}
          >
            <div className="text-center">
              <span className={clsx('block', isMission ? 'text-2xl' : 'text-xl')}>
                {node.emoji}
              </span>
              {isMission && (
                <span className="text-[9px] font-bold text-[var(--accent-primary)] uppercase tracking-wider">
                  Mission
                </span>
              )}
            </div>

            {/* Name label with improved readability */}
            {!isMission && (
              <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 whitespace-nowrap transition-all" style={{ textShadow: 'var(--force-graph-text-shadow)' }}>
                <span className={clsx(
                  'text-[11px] font-bold transition-all',
                  node.color,
                  isHovered && 'font-black scale-105',
                )} style={{ textShadow: 'var(--force-graph-text-shadow-strong)' }}>
                  {node.name}
                </span>
              </div>
            )}

            {/* Domain label (muted, below name) */}
            {!isMission && node.domain && (
              <div className="absolute -bottom-10 left-1/2 -translate-x-1/2 whitespace-nowrap pointer-events-none opacity-60">
                <span className="text-[9px] text-[var(--text-muted)] font-medium" style={{ textShadow: 'var(--force-graph-text-shadow)' }}>
                  {node.domain}
                </span>
              </div>
            )}

            {/* Active dot — always on for humans */}
            {(isActive || node.isHuman) && !isMission && (
              <div
                className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-[var(--success)] border-2 border-[var(--bg-primary)]"
                style={{ boxShadow: '0 0 8px rgba(52,211,153,0.8)' }}
              />
            )}

            {/* Hover tooltip (hide when settings open) */}
            {isHovered && !isDragging && !isMission && !isSelected && (
              <div
                className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap pointer-events-none animate-rise"
                style={{ bottom: node.size / 2 + 32, zIndex: 200 }}
              >
                <div className="bg-[var(--card)] border border-[var(--border-strong)] rounded-[var(--radius-md)] px-4 py-2.5 shadow-[var(--shadow-lg)]">
                  <p className={clsx('text-[var(--text-sm)] font-bold', node.color)}>
                    {node.name}
                  </p>
                  <p className="text-[var(--text-xs)] text-[var(--text-muted)] mt-0.5">{node.domain}</p>
                  {status && (
                    <p className="text-[var(--text-xs)] text-[var(--success)] mt-1.5 border-t border-[var(--border-subtle)] pt-1.5">
                      {status.status}
                    </p>
                  )}
                  {!status && isActive && (
                    <p className="text-[var(--text-xs)] text-[var(--success)] mt-1.5">Active</p>
                  )}
                </div>
              </div>
            )}

            {/* Settings panel — flip above if node is in lower half */}
            {isSelected && (
              <div
                className="absolute"
                style={{
                  ...(node.y > 310
                    ? { bottom: node.size / 2 + 12, left: '50%', transform: 'translateX(-50%)' }
                    : { top: node.size / 2 + 12, left: '50%', transform: 'translateX(-50%)' }
                  ),
                }}
              >
                <NodeSettings
                  node={node}
                  onChange={(updates) => handleNodeChange(node.id, updates)}
                  onClose={() => setSelectedNode(null)}
                />
              </div>
            )}
          </div>
        );
      })}


    </div>
  );
}
