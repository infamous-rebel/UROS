
# UROS Color System — Locked

## Design Philosophy

UROS uses a warm, open, and precise visual language. The palette is built on trust, calm, and clear separation between machine work and human judgment.

-   **Machine work** = Deep Teal
-   **Human decision** = Light Terracotta
-   **Attention required** = Amber
-   **Trust and neutrality** = Off-white and Dark Slate

No dark, futuristic, or black-box aesthetics. UROS must look like a well-lit operations room where nothing is hidden.

----------

## Layer 1: System / Product UI

Used inside the actual UROS application — dashboards, review queues, rule builders, audit logs.

Role

Color

Hex

Background

Warm off-white

`#FAF9F5`

Surface

White

`#FFFFFF`

Text primary

Dark slate

`#1F1E1D`

Text secondary

Muted gray

`#6B6560`

System / Agent

Deep teal

`#0F766E`

Human action

Light terracotta

`#E2725B`

Alert / warning

Amber

`#D97706`

Success

Muted green

`#15803D`

Danger

Muted red

`#B91C1C`

Border

Soft warm gray

`#E7E5E4`

----------

## Layer 2: Marketing / Brand Site

Used on the landing page, website, logo, and motion graphic.

Role

Color

Hex

Background

Light warm ivory

`#FAF9F5`

Hero headline

Dark slate

`#1F1E1D`

Accent

Terracotta

`#E2725B`

Secondary accent

Amber

`#F59E0B`

System demo visuals

Deep teal

`#0F766E`

Cards

White

`#FFFFFF`

----------

## Synchronization Rules

1.  Off-white base is always present in both system UI and marketing.
2.  Teal appears wherever automation, agents, rules, or pipeline are shown.
3.  Terracotta appears wherever human judgment, override, or approval is shown.
4.  Amber signals "attention needed, human input required."
5.  Amber and terracotta must remain visually distinct:
    -   Terracotta = human action taken or required.
    -   Amber = system flag waiting for human input.

----------

## Typography

Element

Font

UI and body

Inter or Manrope

Headings

Inter or Manrope semibold

Code / rules

JetBrains Mono

----------

## Motion Principles

-   Subtle transitions, 200–300ms.
-   Flat 2D vector style for motion graphic.
-   No frantic motion. Calm, clear, explainable.
-   Teal for agents moving through pipeline.
-   Terracotta for human click/approval moments.
-   Amber pulse for needs-review flags.

----------

## Status Colors

Status

Color

Auto-Pass

Muted green `#15803D`

Auto-Fail

Muted red `#B91C1C`

Needs Review

Amber `#D97706`

Human Override

Terracotta `#E2725B`

Verified

Muted green `#15803D`

Verification Failed

Muted red `#B91C1C`

----------

## Summary

This color system is the single source of truth for all UROS design work — system UI, marketing site, logo, and motion graphics. It visually communicates UROS core promise: transparent automation with human control.
