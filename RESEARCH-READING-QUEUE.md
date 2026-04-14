# Void Memory — Research Reading Queue

Running list of papers conceptually relevant to Void Memory recall mechanics, the three-state system, void-fraction filtering, and the broader theoretical framing of the architecture. Entries are flagged for future reading — not required for current operations, but worth understanding as the system matures and is written up publicly (Void Memory paper, open-source release, conference talks).

Each entry: citation, why it matters to us, what specifically to read for, urgency.

Authoritative location: `/opt/void-memory/RESEARCH-READING-QUEUE.md` on CT 215.

---

## 2026-04-14 · Perugu, Kobrin, Flynn, Scaffidi — Krylov Winding

**Citation.** Perugu, Kobrin, Flynn, Scaffidi. *Krylov Winding.* arXiv:2509.25331v2 (2026).

**Why it matters to us.** Conceptually relevant to Void Recall. Three specific hooks:

1. **Krylov basis as a 1D memory chain.** The paper frames Krylov subspace dynamics as a linear "memory chain" where information propagates from an initial state outward through a sequence of basis vectors. This is structurally similar to the way Void Memory's recall pipeline walks from a query seed through scored→filtered→retained blocks, with each pass compressing the state further. Worth reading for the question: is our three-pass recall (TF-IDF score → void mark → budget fit) isomorphic to a truncated Krylov walk, and if so, can we borrow their analysis tools?

2. **Phase coherence across scrambled sets.** The paper studies how phase relationships survive or fail to survive scrambling dynamics. Void Memory has an analogous question: when blocks are voided by cluster-gap detection, do the *remaining* active blocks retain coherent "phase" (semantic alignment with the query) or do they become a random subset? If the paper's phase-coherence metric translates, it could give us a quantitative measure of recall quality that isn't just "did we return the right blocks."

3. **h = λL/(2α) as a recall-health diagnostic.** This is the headline practical takeaway — a closed-form expression for a "winding health" parameter h that collapses system-size L, a coupling constant λ, and a decay rate α into a single scalar. Gavin's instinct is that it maps onto Void Memory's recall health: λ ≈ query specificity, L ≈ block count, α ≈ void fraction. If the mapping holds, h becomes a new operational metric we can surface on the Void Memory health panel (block #6617 master spec, v0.3 memory-wiring phase of g4inspire).

**What to read for.**
- Section defining the Krylov chain construction (hooks #1, #2).
- Whatever section derives h = λL/(2α) — work through the derivation carefully and see if our variables substitute cleanly.
- Any figure showing phase-coherence decay vs. h — we need the visual intuition for what "healthy" looks like.
- Conclusion section for forward-looking claims about generalising the framework.

**Urgency.** Forward-looking, not urgent. No current operational dependency. Read when bandwidth allows — ideally before the Void Memory writeup or any public release, so we can either cite them as conceptual background or contact the authors if our mapping holds.

**Location.** Gavin dropped it in Google Drive. gdrive mount is currently offline (mp0 commented out in CT 215 pct config during the April 13 thin-pool recovery); file should appear in `/mnt/gdrive-sync/` once the mount is restored, or retrievable via `arxiv.org/abs/2509.25331v2`.

**Flagged by.** Gavin, 2026-04-14.
