# UROS System UI/UX Direction — Locked

## Core Principle

Every screen in UROS has a job. Every corner shows work — active, pending, or completed. No empty placeholders, no decorative panels, no "coming soon" unless genuinely outside scope.

UROS is a **live operations floor**, not a brochure.

----------

## Five Core Zones of the System

### 1. Command Bar (Top, Always Present)

-   Tenant/org switcher
-   Active circular or batch selector
-   Global search across candidates, rules, logs
-   Live status summary: Auto-Pass, Auto-Fail, Needs Review, Overdue gates
-   User avatar and role

No empty state. If no batch is selected, show most recent batch and prompt to select another.

### 2. Live Pipeline (Primary Workspace)

Horizontal or vertical flow showing all stages.

```

[Intake] → [Eligibility] → [Scoring] → [Review] → [Verification] → [Offer]
```

Each stage shows a live count. Each count is clickable. Stages with action needed show amber pulse. Completed stages show green.

No static pipeline diagram. Always fed by real data.

### 3. Decision Queue (Where Humans Act)

-   List of candidates needing action
-   Each row: name, candidate ID, reason code, evidence snippet, recommended action, time in queue
-   Batch action bar appears when multiple selected
-   Filter chips: Auto-Fail, Borderline, OCR Issue, Verification Issue

If queue empty:

> "All clear. 1,200 candidates processed in the last hour."

Not a dead screen — a live status confirmation with stats.

### 4. Activity / Audit Stream (Right Side, Persistent)

Shows real-time:

-   Agent actions (Intake processed 2,000)
-   Human actions (R.K. approved batch)
-   Rule changes (S.A. updated CGPA threshold)
-   Gate resolutions (M.H. approved final list)

This is the pulse of the system. Not decorative.

### 5. Right Panel / Inspector (Contextual)

When candidate, rule, or batch selected, shows context:

-   Candidate: evidence, extracted fields, rule applied, history, documents, notes
-   Rule: version history, affected candidates count, simulation result, author
-   Batch: funnel stats, time elapsed, bottlenecks, next gate

If nothing selected, defaults to **live summary** of current batch. Never says "No data."

----------

## Section-Specific Directions

### A. Dashboard / Home

Operations cockpit, not marketing dashboard.

-   Top: active batches with progress bars and gate status
-   Middle: pipeline funnel with live counts
-   Bottom: recent human decisions and agent activity
-   Right: alerts, overdue gates, verification failures

Every metric clickable. No static charts. No "welcome" filler.

### B. Brain Studio (Configuration)

-   Visual pipeline at top
-   Rule cards in center
-   Audit rail on right
-   No blank canvas — always opens with guided flow or existing rule pack

Every rule card shows how many candidates it affected in latest run. Configuration is connected to outcomes, not abstract.

### C. Candidate Review

-   Split view: left = decision queue list, center = evidence panel, right = candidate history and rule path
-   Evidence panel compares original document vs extracted data
-   Every candidate has a decision trail: Intake → Parser → Eligibility → Human → Next stage

If candidate has no documents, system shows what is missing and offers "Request Documents" as primary action.

### D. Verification Center

-   Shows verification batches by source: CIB, Education Board, Police, References
-   Each source shows: pending, verified, failed, manual review counts
-   Clicking a count opens relevant queue
-   If all verified, show completion summary with export option

### E. Reports

-   Each report is a live query, not a static chart
-   Show real-time funnel, error rates, time saved, override patterns, audit activity
-   Export buttons always visible
-   If no data for selected period, suggest nearest period with data

### F. Appeals

-   Each appeal shows original decision, reason, submitted documents, reviewer, SLA timer
-   If no appeals, show summary of closed appeals and average resolution time

### G. BYOK / Provider Settings

-   Shows which providers are active per agent
-   Budget used vs budget cap per provider
-   Model selection per agent
-   Local model status if connected
-   Fallback chain visualization: OpenAI → Anthropic → Ollama

This is a control panel for ownership, not a settings page.

----------

## Anti-Dead-Space Rules

1.  No screen may show only "No data found." Always show context or an action.
2.  Every table row must be clickable or expandable.
3.  Every stage count must be live-updating.
4.  Every human decision must appear in the audit stream.
5.  Empty queues show recent activity and stats.
6.  Settings panels show current values, not blank forms.
7.  Reports show actionable summaries, not just charts.
8.  Right panel always shows something contextual or a live overview.

----------

## Color Mapping (from UROS_Color_System.md)

Element

Color

Pipeline nodes

Deep teal

Active stage

Teal border + subtle glow

Human approval actions

Terracotta

Needs review flags

Amber

Audit rail entries

Muted gray with colored action icons

Draft changes

Amber dot

Published changes

Green check

Rule cards

White surface, warm gray border

Delete/remove

Muted red, with confirmation

----------

## Summary

UROS UI/UX = live operations floor.

No dead space. No decorative hero inside the app. Every section shows work or the result of work. The system feels like a busy, transparent control room — calm but active.

```

Add this to the knowledge folder. It locks the UI/UX direction for all future design and implementation work.
```
