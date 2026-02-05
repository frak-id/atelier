# L'atelier Roadmap

> Open-source Firecracker microVM orchestrator for isolated development environments

## Vision

L'atelier aims to become the **go-to self-hosted platform** for secure, isolated development sandboxes - serving both human developers and AI agents with VM-level isolation, instant startup, and zero operational overhead.

---

## Roadmap Overview

```
Phase 1: Public Release          Phase 2: Killer Features
(OSS Ready)                      (Community-Driven)
     |                                 |
     v                                 v
+-----------------+            +----------------------+
| - Fix coupling  |            | - Provider abstraction|
| - Contributing  |            | - Multi-host swarm   |
| - DevContainer  |            | - AI agent runtime   |
| - Config extract|            | - Air-gapped mode    |
| - Single init   |            | - Bring your own LLM |
+-----------------+            +----------------------+
     |                                 |
     v                                 v
  4-6 weeks                        8-12 weeks
```

---

## Phase Summary

### [Phase 1: Preparing Public Release](./phase-1-public-release.md)

**Goal:** Make the codebase ready for open-source contributors and easy deployment.

| Focus Area | Status | Priority |
|------------|--------|----------|
| Fix circular dependencies | Planned | Critical |
| CONTRIBUTING.md guide | Planned | Critical |
| DevContainer support | Planned | High |
| Extract hardcoded values | Planned | Critical |
| Single `atelier init` | Planned | High |
| Basic test suite | Planned | High |
| GitHub Actions CI | Planned | High |

**Timeline:** 4-6 weeks
**Effort:** ~50-60 hours

---

### [Phase 2: Killer Features](./phase-2-killer-features.md)

**Goal:** Differentiate Atelier with enterprise-grade features based on community feedback.

| Focus Area | Status | Priority |
|------------|--------|----------|
| Infrastructure provider interfaces | Planned | High |
| Multi-host swarm architecture | Planned | High |
| AI agent runtime positioning | Planned | Medium |
| Fully air-gapped deployment | Planned | High |
| Bring your own model (BYOM) | Planned | Medium |

**Timeline:** 8-12 weeks (after Phase 1)
**Effort:** ~150-200 hours
**Trigger:** Community feedback, early adopter requests

---

## Supporting Documents

- [Swarm Architecture Spec](./swarm-architecture.md) - Technical design for multi-host deployment
- [Competitive Analysis](./competitive-analysis.md) - Market positioning and differentiation

---

## Success Metrics

| Metric | Phase 1 Target | Phase 2 Target |
|--------|----------------|----------------|
| GitHub Stars | 1,000 | 5,000 |
| Contributors | 5 | 20 |
| Setup Time | <15 min | <10 min |
| Corporate Users | 1 | 5 |
| Documentation Coverage | 80% | 95% |

---

## How to Contribute

After Phase 1 launch, see [CONTRIBUTING.md](../../CONTRIBUTING.md) for:
- Development setup
- Code style guidelines
- Pull request process
- Issue reporting

---

## Feedback

We're building this for the community. Share your thoughts:
- GitHub Issues for bugs and features
- Discussions for architecture questions
- Twitter/X for quick feedback

**Your input directly shapes Phase 2 priorities.**
