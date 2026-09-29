/**
 * Quest 05 Part 8c — Icon system.
 * Single wrapper for Lucide icons with tone and size control.
 * Never import Lucide directly outside this file.
 */

import type { LucideIcon } from "lucide-react";

interface IconProps {
  icon: LucideIcon;
  size?: number;
  tone?: "neutral" | "system" | "human" | "attention";
  className?: string;
}

export function Icon({ icon: IconCmp, size = 20, tone = "neutral", className }: IconProps) {
  const toneClass = {
    neutral: "text-slate-600",
    system: "text-teal-700",
    human: "text-terracotta-600",
    attention: "text-amber-600",
  }[tone];

  return (
    <IconCmp
      size={size}
      strokeWidth={1.5}
      className={`${toneClass} ${className ?? ""}`}
    />
  );
}
