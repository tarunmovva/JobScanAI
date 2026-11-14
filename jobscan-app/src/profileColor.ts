// Deterministic identity color per profile id — the signature element of the
// profile switcher: one glance answers "which me am I applying as?".
export function profileDotColor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return `hsl(${h % 360}, 70%, 55%)`
}
