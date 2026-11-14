import { Asterisk } from 'lucide-react'

interface Props {
  size?: number
  className?: string
}

// Claude-style thinking indicator: a breathing, slowly turning spark.
// Replaces bouncing-dot spinners everywhere something is generating.
export default function Spark({ size = 16, className = 'text-orange-400' }: Props) {
  return <Asterisk size={size} strokeWidth={2.5} className={`animate-spark ${className}`} aria-hidden />
}
