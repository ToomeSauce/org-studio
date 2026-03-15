'use client';

import { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import { clsx } from 'clsx';
import { Teammate, resolveColor } from '@/lib/teammates';

interface Planet {
  id: string;
  name: string;
  emoji: string;
  domain: string;
  color: string;
  isHuman?: boolean;
  glowColor: string;
  bgColor: string;
  orbitIndex: number;
  startAngle: number;
  orbitSpeed: number;
  size: number;
  isActive?: boolean;
  status?: string;
}

function buildPlanets(teammates: Teammate[]): Planet[] {
  const nonHumans = teammates.filter(t => !t.isHuman);
  const nonHumanCount = Math.max(nonHumans.length, 1);
  let agentIdx = 0;
  return teammates.map((t) => {
    const c = resolveColor(t.color);
    const isHuman = t.isHuman || false;
    const angle = isHuman ? 0 : (agentIdx++ * (360 / nonHumanCount));
    return {
      id: t.agentId || t.id,
      name: t.name,
      emoji: t.emoji,
      domain: t.domain,
      color: c.text,
      glowColor: c.glowRgba,
      bgColor: c.bgRgba,
      orbitIndex: isHuman ? 0 : 1,
      startAngle: angle,
      orbitSpeed: isHuman ? 8 : 3,
      size: isHuman ? 60 : 70,
      isHuman,
    };
  });
}

const ORBIT_RADII = [130, 280];

interface DragState {
  planetId: string;
  offsetX: number;
  offsetY: number;
}

interface SpringState {
  planetId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  targetX: number;
  targetY: number;
}

export function SolarSystem({
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
  // Build planets from store, apply saved domain overrides
  const planets = useMemo(() => {
    const built = buildPlanets(teammates);
    return built.map(p => {
      const saved = savedNodePhysics?.[p.id];
      if (saved?.domain) return { ...p, domain: saved.domain };
      return p;
    });
  }, [teammates, savedNodePhysics]);

  const containerRef = useRef<HTMLDivElement>(null);
  const [time, setTime] = useState(0);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [springs, setSprings] = useState<Map<string, SpringState>>(new Map());
  const [hoveredPlanet, setHoveredPlanet] = useState<string | null>(null);
  const animRef = useRef<number>(0);
  const lastTimeRef = useRef(0);

  // Animation loop
  useEffect(() => {
    let running = true;
    const animate = (timestamp: number) => {
      if (!running) return;
      if (!lastTimeRef.current) lastTimeRef.current = timestamp;
      const dt = (timestamp - lastTimeRef.current) / 1000;
      lastTimeRef.current = timestamp;

      setTime(t => t + dt);

      // Update springs
      setSprings(prev => {
        const next = new Map(prev);
        let anyActive = false;
        for (const [id, s] of next) {
          const dx = s.targetX - s.x;
          const dy = s.targetY - s.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 0.5 && Math.abs(s.vx) < 0.5 && Math.abs(s.vy) < 0.5) {
            next.delete(id);
            continue;
          }
          anyActive = true;
          // Spring: k=8, damping=4
          const k = 8;
          const damp = 4;
          s.vx += (dx * k - s.vx * damp) * dt;
          s.vy += (dy * k - s.vy * damp) * dt;
          s.x += s.vx * dt * 60;
          s.y += s.vy * dt * 60;
        }
        return next;
      });

      animRef.current = requestAnimationFrame(animate);
    };
    animRef.current = requestAnimationFrame(animate);
    return () => { running = false; cancelAnimationFrame(animRef.current); };
  }, []);

  // Calculate orbital position for a planet
  const getOrbitalPos = useCallback((planet: Planet, t: number) => {
    const radius = ORBIT_RADII[planet.orbitIndex];
    const angle = (planet.startAngle + t * planet.orbitSpeed) * (Math.PI / 180);
    return {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius * 0.45, // elliptical — flatten for perspective
    };
  }, []);

  // Pointer handlers
  const handlePointerDown = useCallback((e: React.PointerEvent, planetId: string) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    setDragState({
      planetId,
      offsetX: e.clientX - centerX,
      offsetY: e.clientY - centerY,
    });
    setDragPos({ x: e.clientX - centerX, y: e.clientY - centerY });
    // Remove any active spring for this planet
    setSprings(prev => { const n = new Map(prev); n.delete(planetId); return n; });
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragState) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    setDragPos({ x: e.clientX - centerX, y: e.clientY - centerY });
  }, [dragState]);

  const handlePointerUp = useCallback(() => {
    if (!dragState || !dragPos) { setDragState(null); setDragPos(null); return; }
    const planet = planets.find(p => p.id === dragState.planetId);
    if (!planet) { setDragState(null); setDragPos(null); return; }

    const target = getOrbitalPos(planet, time);
    setSprings(prev => {
      const n = new Map(prev);
      n.set(dragState.planetId, {
        planetId: dragState.planetId,
        x: dragPos.x,
        y: dragPos.y,
        vx: 0,
        vy: 0,
        targetX: target.x,
        targetY: target.y,
      });
      return n;
    });

    setDragState(null);
    setDragPos(null);
  }, [dragState, dragPos, time, getOrbitalPos]);

  // Get planet display position
  const getPlanetPos = (planet: Planet) => {
    if (dragState?.planetId === planet.id && dragPos) {
      return dragPos;
    }
    const spring = springs.get(planet.id);
    if (spring) {
      return { x: spring.x, y: spring.y };
    }
    return getOrbitalPos(planet, time);
  };

  return (
    <div
      ref={containerRef}
      className="relative w-full select-none"
      style={{ height: 496 }}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
    >
      {/* Orbital rings */}
      {ORBIT_RADII.map((r, i) => (
        <div
          key={i}
          className="absolute border border-dashed rounded-full pointer-events-none"
          style={{
            width: r * 2,
            height: r * 2 * 0.45,
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            borderColor: i === 0 ? 'var(--orbit-inner)' : 'var(--orbit-outer)',
          }}
        />
      ))}

      {/* Sun — The Mission */}
      <div
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-10"
        style={{ width: 120, height: 120 }}
      >
        <div className="w-full h-full rounded-full flex items-center justify-center"
          style={{
            background: 'radial-gradient(circle, rgba(255,92,92,0.25) 0%, rgba(255,92,92,0.05) 60%, transparent 100%)',
            boxShadow: '0 0 40px rgba(255,92,92,0.2), 0 0 80px rgba(255,92,92,0.1)',
            animation: 'pulse-glow 4s ease-in-out infinite',
          }}
        >
          <div className="text-center">
            <div className="text-2xl mb-0.5">🎯</div>
            <div className="text-[10px] font-bold text-[var(--accent-primary)] uppercase tracking-wider">Mission</div>
          </div>
        </div>
      </div>

      {/* Planets — sorted by Y for depth layering */}
      {planets
        .map(p => ({ planet: p, pos: getPlanetPos(p) }))
        .sort((a, b) => a.pos.y - b.pos.y)
        .map(({ planet, pos }) => {
          const isActive = activeAgentIds.has(planet.id);
          const status = activityStatuses[planet.id];
          const isDragging = dragState?.planetId === planet.id;
          const isHovered = hoveredPlanet === planet.id;
          // Scale based on Y position for pseudo-3D depth
          const depthScale = 0.8 + (pos.y + ORBIT_RADII[1] * 0.45) / (ORBIT_RADII[1] * 0.9) * 0.4;
          const zIndex = Math.round(pos.y + 200);

          return (
            <div
              key={planet.id}
              className="absolute cursor-grab active:cursor-grabbing"
              style={{
                left: '50%',
                top: '50%',
                width: planet.size,
                height: planet.size,
                transform: `translate(calc(-50% + ${pos.x}px), calc(-50% + ${pos.y}px)) scale(${isDragging ? 1.15 : depthScale})`,
                zIndex: isDragging ? 100 : zIndex,
                transition: isDragging ? 'none' : 'transform 0.05s linear',
              }}
              onPointerDown={(e) => handlePointerDown(e, planet.id)}
              onPointerEnter={() => setHoveredPlanet(planet.id)}
              onPointerLeave={() => setHoveredPlanet(null)}
            >
              {/* Planet body */}
              <div
                className="w-full h-full rounded-full flex items-center justify-center"
                style={{
                  background: planet.bgColor,
                  boxShadow: `0 0 ${isActive ? 16 : 8}px ${planet.glowColor}, inset 0 -2px 4px rgba(0,0,0,0.2)`,
                  border: `2px solid ${planet.glowColor.replace(/[\d.]+\)$/, '0.3)')}`,
                }}
              >
                <span className="text-xl" style={{ filter: isDragging ? 'brightness(1.3)' : undefined }}>
                  {planet.emoji}
                </span>
              </div>

              {/* Name label */}
              <div className="absolute -bottom-5 left-1/2 -translate-x-1/2 whitespace-nowrap text-center">
                <span className={clsx('text-[11px] font-bold', planet.color)}>
                  {planet.name}
                </span>
              </div>

              {/* Active dot — always on for humans */}
              {(isActive || planet.isHuman) && (
                <div
                  className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-[var(--success)] border-2 border-[var(--bg-primary)]"
                  style={{ boxShadow: '0 0 6px rgba(52,211,153,0.6)' }}
                />
              )}

              {/* Hover tooltip */}
              {isHovered && !isDragging && (
                <div
                  className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap pointer-events-none"
                  style={{ bottom: planet.size + 12, zIndex: 200 }}
                >
                  <div className="bg-[var(--card)] border border-[var(--border-strong)] rounded-[var(--radius-md)] px-3 py-2 shadow-[var(--shadow-lg)]">
                    <p className={clsx('text-[var(--text-xs)] font-bold', planet.color)}>{planet.domain}</p>
                    {status && (
                      <p className="text-[var(--text-xs)] text-[var(--success)] mt-1">{status.status}</p>
                    )}
                    {!status && isActive && (
                      <p className="text-[var(--text-xs)] text-[var(--text-muted)] mt-1">Active</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}

      {/* CSS for sun pulse */}
      <style jsx>{`
        @keyframes pulse-glow {
          0%, 100% { box-shadow: 0 0 40px rgba(255,92,92,0.2), 0 0 80px rgba(255,92,92,0.1); }
          50% { box-shadow: 0 0 60px rgba(255,92,92,0.3), 0 0 100px rgba(255,92,92,0.15); }
        }
      `}</style>
    </div>
  );
}
