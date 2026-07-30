<!-- Canonical human-readable copy. Source of truth at runtime is the store
     (org_studio_vision_docs / GET /api/vision/proj-org-studio/doc). Keep in sync
     when the live doc changes. Direction reset approved by Basil 2026-07-16. -->

# Org Studio

## Meta
- **Version:** 2026.11.15 *(roadmap calver; repo releases use semver)*
- **Last Updated:** 2026-07-16
- **Vision Owner:** Basil
- **Dev Owner:** Mikey
- **QA Owner:** Billy
- **Lifecycle:** building — OSS community product
- **Repo:** ToomeSauce/org-studio (MIT open source)
- **First-class dependencies:** OpenClaw or Hermes Agent
- **Deployment:** self-hosted in a trusted environment

## North Star

**Org Studio is the open-source operating studio for named OpenClaw and Hermes agent teams.**

It is for indie developers, home labs, researchers, and small teams experimenting with persistent AI teammates. A human establishes the mission, culture, vision, ownership boundaries, and approval leash; named agents work in durable domains and improve through shared organizational context and feedback.

The atomic unit is the **owned domain**: a named human or agent accountable for an area over time. Vision, roadmap, work, culture, memory, and measurement orbit that ownership.

Org Studio deliberately optimizes for **expressive, persistent agent teams in trusted self-hosted environments**. It does not claim to be the security or cost model for enterprise software delivery. That product is Materialyze.

## Audience and Promise

Org Studio serves people who already use—or explicitly want to use—OpenClaw or Hermes as persistent general-purpose agents.

Its promise is:

> Define the organization once. Give every teammate a durable identity, domain, culture, vision, and leash. Let the runtime agents carry that context into their ongoing work.

Good fits:
- Home labs and personal AI teams
- Indie products and side projects
- Prototypes and experiments
- Research into agent identity, culture, coaching, and autonomous ownership
- Small trusted teams comfortable operating general-purpose agent runtimes

Not the target:
- Enterprise software-delivery environments that prohibit generalized assistant runtimes
- Zero-trust, least-privilege coding execution
- Faceless stateless worker fleets
- Model-by-model cost routing for production engineering
- Hosted commercial SaaS, billing, SSO/SCIM, or enterprise procurement

## Three Pillars

### 1. Named ownership
Every domain has a durable owner—human or agent—with a clear contract: mission, owns, defers, roadmap, and escalation boundaries. The product makes responsibility legible without turning one agent into another agent's manager.

### 2. Runtime-native organizational context
Org Studio turns org design into context OpenClaw and Hermes agents can actually use: ORG.md, vision docs, roadmap state, task comments, shared memory, kudos, flags, and operating principles. Persistent runtime memory and persona are features here, not liabilities to disguise.

### 3. Autonomy with a visible leash
Humans set the vision, budget, boundaries, approval horizon, outcome metrics, and kill switches. Runtime agents execute inside that leash. Reversible decisions are autonomous by default; irreversible, external, security-sensitive, and explicitly reserved decisions return to the human.

## Product Doctrine

- **Agents are teammates here.** They may have names, roles, faces, memory, and durable domains. That is the product choice.
- **OpenClaw and Hermes are first-class, not incidental adapters.** Org Studio may preserve an internal runtime interface for clean implementation, but it does not market itself as a universal execution fabric.
- **Trusted-environment assumption.** General-purpose runtimes can access broad capabilities. Operators are responsible for securing the host and runtime configuration.
- **The board is organizational state.** It coordinates ownership and handoffs; it is not a generic background-job queue.
- **Human vision ownership remains explicit.** Agents may propose changes; humans own mission-level direction and approval horizons.
- **Local-first and self-hosted.** File mode remains useful for a zero-database start; Postgres remains available for durable multi-user installations.
- **MIT and community-oriented.** Org Studio remains open source. There is no hosted-cloud or billing commitment in its roadmap.

## Current Product

### Keep and deepen
- OpenClaw and Hermes discovery, health, dispatch, and metadata integration
- Named teammate roster, roles, domains, Owns/Defers contracts, and ORG.md generation
- Mission, values, culture, kudos, flags, coaching, and performance feedback
- Project vision docs and human-owned roadmap approval
- Context board, comments, dependencies, handoffs, and status history
- Approval horizon, project start/stop, budget, boundaries, and loop kill-switches
- Outcome-bound versions and the experiment loop
- Shared org memory and decision provenance
- Runtime cost observability, health, schedule diagnostics, and activity history
- Local self-hosting, backups, upgrades, and runtime onboarding

### Extract to Materialyze, then remove from Org Studio
The following capabilities were built in Org Studio while the runtime-free product direction was still being explored. They are useful work, but they no longer belong in this product's architecture:

- Execution Worker runtime and worker configuration
- Codex and OpenAI-compatible direct coding engines
- Ephemeral runner provisioning and GitHub Actions worker workflow
- HostProfile enforcement for faceless coding jobs
- RepoContextPack generation for stateless workers
- Frontier planner jobs and planner materialization
- `modelTier` routing to trivial/standard/complex worker pools
- Worker scorecards and pipeline receipts
- Runtime-independent Telegram/Slack command adapters created for runtime-less deployments

**Removal rule:** do not delete these capabilities until the Materialyze repository has received the relevant code, retained required MIT notices, and passed equivalence checks. After extraction, remove their routes, UI, settings, schemas that are not shared with the runtime-agent product, tests, workflows, and documentation from Org Studio.

### Keep even if Materialyze develops a counterpart
Some concepts serve both products but have different implementations and trust models. Org Studio keeps its own versions of:

- Vision and roadmap
- Human approval horizons
- Budget and boundary fields
- Task dependencies and comments
- Org memory
- Cost and delivery metrics

These are product concepts, not a reason for the two applications to share a deployment or security boundary.

## Relationship to Materialyze

Materialyze is a separate commercial product for serious software creation and ongoing codebase ownership. It uses persistent project memory with faceless, ephemeral, stateless workers; direct model connections; cost-aware routing; isolated execution; least-privilege credentials; and complete audit receipts.

There is no maturity ladder where a Materialyze project "graduates" into Org Studio. The two products make different trust choices:

- **Org Studio:** persistent named agents in a trusted self-hosted environment.
- **Materialyze:** persistent project state with disposable workers in a governed execution environment.

Org Studio may incubate ideas. Materialyze may selectively productize proven ideas under stricter contracts. A future import path may move an experimental Org Studio project into Materialyze, but the applications remain operationally and architecturally separate.

## Forward Arc

### 1. Materialyze separation
- Establish the separate Materialyze repository and licensing boundary.
- Transfer worker, planner, model-routing, provisioning, receipt, and runtime-independent messaging work.
- Verify capability equivalence in Materialyze.
- Remove transferred surfaces from Org Studio without disturbing named-runtime workflows.
- Publish a clear migration note for contributors and existing experimental users.

### 2. Runtime foundation cleanup
- Make OpenClaw and Hermes onboarding direct and honest.
- Remove generic claims that imply every agent framework is equally supported.
- Harden runtime discovery, dispatch reliability, health reporting, and metadata sync.
- Make trusted-host assumptions and security responsibilities explicit.

### 3. Turnkey personal agent teams
- Teammate archetypes for OpenClaw/Hermes with transparent skills, memory, and permissions.
- Starter org templates for personal projects, home labs, indie products, and research teams.
- Fast local setup from runtime detection to first owned domain.

### 4. Organizational learning
- Deepen shared org memory, decision history, outcome loops, coaching, and cultural feedback.
- Help persistent teammates inherit domain context and learn from prior attempts without flattening the org into chat.

### 5. OSS durability
- Reliable local install and upgrade path
- Backups and recovery
- Contributor documentation
- Focused compatibility testing against supported OpenClaw/Hermes versions
- Sustainable maintenance without a hosted SaaS obligation

## Commercialization

Org Studio is not the commercial cloud product.

- The repository remains MIT open source.
- Self-hosting remains the expected deployment.
- No Org Studio Cloud, billing system, vertical paid templates, or enterprise tier is planned.
- Community sponsorship, support, or services may be considered later, but they are not the product thesis.
- Commercial cloud, enterprise security, managed execution, billing, and the generous free tier belong to Materialyze.

## Boundaries

- No direct LLM coding engines in the steady-state Org Studio product.
- No faceless stateless-worker orchestration after the Materialyze extraction.
- No hosted multi-tenant cloud or billing roadmap.
- No claim that general-purpose runtimes satisfy enterprise least-privilege requirements.
- No attempt to make named agents look faceless; identity and durable ownership are intentional here.
- No production deployment engine; Org Studio coordinates runtime teammates and records work.
- No Slack replacement; conversation is a feature inside a domain, never the foundation.
- No destructive removal of transitional code before Materialyze extraction and verification.
- Repo releases use semver; product roadmap and approval horizons use calver.

## Decision Record — 2026-07-16

The worker/planner experiments revealed a second product rather than a fourth Org Studio pillar.

Three weaknesses in the persistent-agent approach became structural:

1. General-purpose assistant contexts are token-heavy for bounded coding work.
2. Named personas can personalize work that should be evaluated as replaceable execution capacity.
3. Open-ended agent autonomy is less predictable than a deterministic pipeline of approved, context-complete jobs.

For enterprise and serious commercial software work, the worker architecture also provides the stronger security model: ephemeral execution, no channels or personal memory, least-privilege credentials, bounded tools, model governance, and complete receipts.

Therefore:

- Org Studio returns to a focused OSS product for named OpenClaw/Hermes agent teams.
- Materialyze becomes the separate commercial product for secure, stateless, cost-optimized, ongoing software delivery.
- The Org Studio cloud/billing plan moves to Materialyze.
- Transitional worker/planner/runtime-less messaging code is extracted before removal.

## Change History

| Date | Version | Author | Change |
|---|---|---|---|
| 2026-07-16 | 2026.11.15 | Basil/Mikey | **Org Studio / Materialyze product split.** Narrowed Org Studio to an MIT, self-hosted operating studio for named OpenClaw/Hermes agent teams in trusted environments. Removed enterprise/cloud ambitions from its North Star and roadmap. Classified worker, planner, direct-model, stateless-context, runtime-less messaging, and worker-audit capabilities for extraction into Materialyze before removal. Materialyze owns the commercial, enterprise, secure, cost-optimized software-delivery path. |
| 2026-07-07 | 2026.11.15 | Basil/Mikey | Built the worker, native-messaging, and Studio Planner direction inside Org Studio. This work is now treated as the validated prototype substrate for Materialyze rather than Org Studio's permanent architecture. |
| 2026-06-02 | 2026.05 | Basil/Mikey | Reality audit reframed the original product around owned domains, autonomy within guardrails, and turnkey named teams. |
