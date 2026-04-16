/**
 * Bridge between store route and scheduler — shared in-flight tracking
 * 
 * The scheduler sets agents as "in-flight" when dispatching tasks.
 * The store route clears in-flight when an agent completes a task (moves to done/review).
 * This is the definitive completion signal for OpenClaw agents, which don't have
 * onComplete callbacks like Hermes agents do.
 */

const inFlightAgents = new Set<string>();
const inFlightTimers = new Map<string, NodeJS.Timeout>();

export function setInFlightAgent(agentId: string, timeoutMs: number = 10 * 60 * 1000): void {
  inFlightAgents.add(agentId);
  // Safety timeout
  const timer = setTimeout(() => {
    inFlightAgents.delete(agentId);
    inFlightTimers.delete(agentId);
    console.log(`[InFlight] Cleared ${agentId} (safety timeout)`);
  }, timeoutMs);
  inFlightTimers.set(agentId, timer);
}

export function clearInFlightAgent(agentId: string): void {
  inFlightAgents.delete(agentId);
  const timer = inFlightTimers.get(agentId);
  if (timer) {
    clearTimeout(timer);
    inFlightTimers.delete(agentId);
  }
  console.log(`[InFlight] Cleared ${agentId} (task completed)`);
}

export function isInFlight(agentId: string): boolean {
  return inFlightAgents.has(agentId);
}
