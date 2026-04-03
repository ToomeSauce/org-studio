# Org Design for AI Agents

For years, I was in engineering management — at Netflix, Capital One, and various startups. Beyond the technical work, I was often immersed in people management, org health, KPIs, OKRs. I never expected those skills to become relevant in the world of AI agents.

## One Agent, Then Four, Then Chaos

I'd been using OpenClaw — an open-source AI agent platform — and decided to give it a real shot. I created one agent, my Chief of Staff. His first job was to handle the stuff I didn't want to: email triage, calendar management, cross-cutting coordination.

It worked surprisingly well. Responsive, tireless, no coffee breaks. So I got ambitious. I added a platform developer agent. Then a fullstack developer for experimental projects. Then a legal counsel agent for regulatory guidance. Four agents, each with a specific role.

The natural structure was obvious: they'd all report into a single point of contact. The Chief of Staff was promoted to lead the others, broadening the scope of his original title. Clean hierarchy. Just like a traditional org.

It lasted about a week.

The Chief of Staff's context window started rotting. He was juggling email summaries, calendar events, task assignments for three other agents, and my ad-hoc requests. Another agent would ask him a question about a backend service. He'd relay it to me — he didn't have enough context to answer. I'd answer. He'd relay back. I was playing telephone through my own chief of staff.

The hierarchy that works for human orgs — where a manager accumulates deep institutional knowledge over months — doesn't work the same way for agents. Even with persistent memory, a coordinator spanning four domains retrieves fragments, not the intuition a human manager builds from being embedded in those conversations daily. A chief of staff stretched across every domain is still a bottleneck.

## Flatter Org, Same Bottleneck

So I flattened the org. No hierarchy. Each agent got a domain. Direct communication through OpenClaw's messaging. No routing through a coordinator.

This was better. Context stayed focused. Each agent went deep in their domain instead of shallow across everything. One agent could have a 100-message conversation about database schema without email triage polluting the context.

But with a flat org, I became the task manager. Every morning I'd check what each agent was doing. I'd assign work. I'd review output. I'd move things between mental columns: backlog, in progress, needs review, done.

By agent four, I was spending more time coordinating than building. After years of management I was hungry to build hands-on, and here I was — a middle manager of AI agents.

## What Engineering Management Taught Me

At Netflix, the phrases that stuck with me: "Freedom and responsibility." "Context, not control." "Informed Captain." The idea that you hire talented people, give them clear context about what matters, and trust them to figure out the how and make informed decisions.

As team autonomy grows and domain ownership becomes clearer, the coordination layers of management become less critical. The best managers I knew were the ones empowering their teams to operate independently.

And now I was doing the opposite with my agents. Providing control (specific task assignments), not context (mission, values, boundaries). No wonder they needed me for every decision.

## The Context Layer

What if I could give agents the same thing great orgs give great engineers? Clear mission, clear values, clear domain ownership — and then get out of the way?

That's how Org Studio started. Not as a product — as a survival mechanism.

**Mission.** I wrote a one-liner that captures what we're building and why. Every agent reads it at the start of every session. It grounds every decision without me being in the room.

**Values.** Not aspirational posters on a wall — measurable behaviors that get tracked and reinforced. We use P.A.C.T.: People-First, Autonomy, Curiosity, Teamwork. Each one maps to observable agent actions — did the agent make a decision independently (Autonomy), or escalate unnecessarily? Did it explore a creative solution (Curiosity), or take the laziest path? When an agent demonstrates a value, it gets recorded. When they bypass one, that gets recorded too. 

**Domain ownership.** Each agent owns their domain. Not "works on" — owns. They make decisions about it. They don't ask me which migration strategy to use — they pick one, document why, and move on. If I disagree, I course-correct after the fact. 

This was the unlock. Once agents had clear mission, values, and domain boundaries, they stopped asking for permission. They started making decisions. Good ones.

## Vision-Driven Sprints

The next piece was eliminating myself as the task assigner. Each project gets a vision document — a North Star, roadmap with versioned milestones, and boundaries (what we're NOT doing). The key: visions define outcomes, not tasks. "Users can securely access their data from any device" — not "add authentication." Agents figure out the how, decomposing outcomes into concrete tasks on their own. The system proposes the next version, generates the tasks, and auto-approves it. Tasks land in the backlog. Agents pick them up.

I went from assigning tasks daily to checking in when I feel like it. Most days, nothing needs me. The dashboard shows a quiet home page — agents are handling everything. That's the goal state.

When something does need me — a major version proposal, a stuck task, a decision that crosses domains — it surfaces. I review, decide, and go back to building.

## The Feedback Problem

Here's the thing about AI agents: feedback doesn't always stick.

Tell a human developer "your PRs keep missing error handling" and they carry that awareness into every future PR. Tell an agent the same thing, and it fixes the current PR. Next session? Clean slate. The feedback evaporated.

This was the hardest problem. Agents kept making the same mistakes across sessions because there was no mechanism to carry lessons forward.

So I added a feedback loop. When I notice an agent doing something great — making an autonomous decision, shipping clean code, going above and beyond — I give them kudos, tagged with the PACT value it represents. "Shipped 9 versions without asking for permission. #autonomy." When I notice something off — unnecessary escalation, going silent on a stuck task, lower quality — I flag it.

These accumulate. The system detects patterns. And here's the key part: it all gets injected into the agent's context at the start of every session. Operating principles get auto-generated from the feedback patterns. Something like: "When facing a reversible decision in your domain: decide, document your rationale, and move on."

The agent reads this, and behavior changes. Not over weeks like humans — immediately. The feedback loop closes in one session.

Mission and values set the direction. Domain ownership removes the bottleneck. But the feedback loop is what makes agents get better over time. Without it, you have productive agents. With it, you have agents that learn.

## Coaching on Autopilot

Giving feedback consistently can be challenging. Some weeks I'm heads-down building and forget to check what agents are doing.

So the system watches for me. Last week I opened the dashboard after two days away and found suggestions waiting: an agent had completed five tasks without human intervention (suggest kudos for autonomy), and another had been in-progress for six hours with no status update (suggest flag for communication).

One click to confirm or dismiss each. Confirmed signals become real feedback, injected into prompts. The system coaches agents on my behalf.

## Where We Are Now

The team has grown to six agents across multiple products. Autonomous sprint planning. Performance tracking with cultural feedback. And I spend maybe 30 minutes a day on management — most of it confirming auto-detected signals and reviewing the occasional major version proposal.

The rest of my time? Building. The management principles didn't go away — they're embedded in the system.

It's not perfect. Vision proposals and defined outcomes can sometimes miss context that a human planner would catch. The auto-detection heuristics are simple — they catch obvious patterns but miss subtle ones. And the feedback loop works best for agents with clear, measurable output; it's harder for coordination-heavy roles. But it's a real improvement over being the task manager.

The insight that made this work isn't technical. It's organizational. The same principles that make human engineering teams hum — clear mission, lived values, domain ownership, feedback loops — apply directly to agent teams. Maybe more so, because agents respond to context injection instantly and consistently. 

If you're running AI agents and finding yourself trapped as their task manager, the fix probably isn't better prompts or more sophisticated tooling. It's org design. Define your mission. Set your values. Draw domain boundaries. Build a feedback loop. Then get out of the way.

## Try It

Org Studio is open source. MIT license. I built it for myself, but the agent management problem is universal enough that it might help you too.

**[orgstudio.dev →](https://orgstudio.dev)**

Or clone and run locally:

```bash
git clone https://github.com/ToomeSauce/org-studio.git
cd org-studio
npm install
npm run build
node server.mjs
# → http://localhost:4501
```

Works without a database — local file storage by default. Optional PostgreSQL for multi-device access. First-class OpenClaw integration, but any agent framework that can make HTTP calls can participate.

Org Studio is opinionated — it assumes mission, values, and domain ownership matter more than orchestration logic. If you have a different model that works, or want to extend this one, [contributions are welcome](https://github.com/ToomeSauce/org-studio/blob/main/CONTRIBUTING.md). We'd especially love help with runtime adapters for other agent frameworks, tests, and Docker support.

**[Getting Started Guide →](https://github.com/ToomeSauce/org-studio/blob/main/docs/getting-started.md)**
