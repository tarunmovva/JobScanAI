import { useEffect, useRef, useState } from 'react'

interface Props {
  value: number
  className?: string
}

// Animated numeral: counts from the currently painted value to `value` over
// ~250ms (rAF). Renders the final value immediately under reduced motion.
export default function TickerNumber({ value, className }: Props) {
  const [shown, setShown] = useState(value)
  const shownRef = useRef(value)
  shownRef.current = shown

  useEffect(() => {
    const from = shownRef.current
    if (from === value) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(value)
      return
    }
    let raf = 0
    const start = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 250)
      setShown(Math.round(from + (value - from) * t))
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value])

  return <span className={className ? `tabular-nums ${className}` : 'tabular-nums'}>{shown.toLocaleString()}</span>
}
