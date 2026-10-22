import { useRef } from "react";
import { resizeValue } from "../features/sessions/sessionLogic";
export function ResizeHandle({
  value,
  change,
  min,
  max,
  reverse = false,
  label,
}: {
  value: number;
  change: (n: number) => void;
  min: number;
  max: number;
  reverse?: boolean;
  label: string;
}) {
  const drag = useRef<{ x: number; value: number } | null>(null);
  const set = (n: number) => change(Math.max(min, Math.min(max, n)));
  return (
    <div
      className="resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={`${value} pixels`}
      title={`${label} — arrow keys resize, Home/End set minimum/maximum`}
      tabIndex={0}
      onKeyDown={(e) => {
        const next = resizeValue(e.key, value, min, max, reverse);
        if (next === null) return;
        e.preventDefault();
        set(next);
      }}
      onPointerDown={(e) => {
        drag.current = { x: e.clientX, value };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (drag.current)
          set(
            drag.current.value +
              (e.clientX - drag.current.x) * (reverse ? -1 : 1),
          );
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
    />
  );
}
