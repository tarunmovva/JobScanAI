import { useEffect, useRef } from 'react'
import * as THREE from 'three'

export type AmbientMode = 'idle' | 'fetching' | 'thinking' | 'auth'

interface Props {
  mode: AmbientMode
  pulse: number   // increment to fire a brief radial brightness wave
}

const COUNT = 3000

// Palette per mode (lerped smoothly at runtime).
// Cool graphite, not terracotta. The field reads as depth behind the console
// rather than warmth in front of it, and it never approaches the signal colour
// -- nothing ambient may compete with a card that needs a human.
const MODE_COLOR: Record<AmbientMode, THREE.Color> = {
  idle:     new THREE.Color('#4d5765'),  // graphite — at rest
  fetching: new THREE.Color('#557bb0'),  // slate-blue — data streaming in
  thinking: new THREE.Color('#7397c7'),  // lighter slate — work in progress
  auth:     new THREE.Color('#4d5765'),
}
// Dimmer across the board. Flat ground is the point; this is a whisper of
// depth, not a feature.
const MODE_OPACITY: Record<AmbientMode, number> = {
  idle: 0.12, fetching: 0.18, thinking: 0.18, auth: 0.22,
}
const MODE_SPEED: Record<AmbientMode, number> = {
  idle: 0.5, fetching: 1.2, thinking: 1.0, auth: 0.7,
}

// One signature ambient layer: a slow-drifting point field behind the UI —
// the job database as a living cloud. Deliberately barely-there; guarded for
// perf (30fps cap, DPR clamp, pauses on blur/hide, static under
// prefers-reduced-motion). pointer-events-none + aria-hidden: invisible to
// interaction and tests.
export default function AmbientField({ mode, pulse }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const modeRef = useRef<AmbientMode>(mode)
  const pulseAtRef = useRef<number>(-1)
  const lastPulseRef = useRef(pulse)

  modeRef.current = mode
  if (pulse !== lastPulseRef.current) {
    lastPulseRef.current = pulse
    pulseAtRef.current = performance.now()
  }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    renderer.setClearColor(0x000000, 0)
    host.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100)
    camera.position.z = 22

    // Shallow ellipsoid point cloud
    const positions = new Float32Array(COUNT * 3)
    const phases = new Float32Array(COUNT)
    for (let i = 0; i < COUNT; i++) {
      const r = 9 + Math.random() * 9
      const theta = Math.random() * Math.PI * 2
      const y = (Math.random() - 0.5) * 10
      positions[i * 3]     = Math.cos(theta) * r
      positions[i * 3 + 1] = y
      positions[i * 3 + 2] = (Math.sin(theta) * r) * 0.45 - 4
      phases[i] = Math.random() * Math.PI * 2
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const mat = new THREE.PointsMaterial({
      size: 0.09,
      transparent: true,
      opacity: MODE_OPACITY.idle,
      color: MODE_COLOR.idle.clone(),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    })
    const points = new THREE.Points(geo, mat)
    scene.add(points)

    const resize = () => {
      const w = host.clientWidth || window.innerWidth
      const h = host.clientHeight || window.innerHeight
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    resize()
    window.addEventListener('resize', resize)

    let raf = 0
    let last = 0
    let paused = false
    const color = MODE_COLOR.idle.clone()

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      if (paused) return
      if (now - last < 33) return   // 30fps cap
      last = now

      const m = modeRef.current
      const speed = MODE_SPEED[m]
      const t = now * 0.00004 * speed

      points.rotation.y = t * 2
      points.rotation.x = Math.sin(t * 0.7) * 0.04

      // Smooth color/opacity toward the mode target
      color.lerp(MODE_COLOR[m], 0.03)
      mat.color.copy(color)

      let targetOpacity = MODE_OPACITY[m]
      // Pulse: 800ms brightness wave after each increment
      if (pulseAtRef.current > 0) {
        const dt = now - pulseAtRef.current
        if (dt < 800) targetOpacity += 0.25 * Math.sin((dt / 800) * Math.PI)
        else pulseAtRef.current = -1
      }
      mat.opacity += (targetOpacity - mat.opacity) * 0.08

      renderer.render(scene, camera)
    }

    if (reduced) {
      renderer.render(scene, camera)   // one static frame
    } else {
      raf = requestAnimationFrame(frame)
    }

    const setPaused = (p: boolean) => { paused = p }
    const onVis = () => setPaused(document.hidden)
    const onBlur = () => setPaused(true)
    const onFocus = () => setPaused(false)
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)

    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('resize', resize)
      geo.dispose()
      mat.dispose()
      renderer.dispose()
      host.removeChild(renderer.domElement)
    }
  }, [])

  return (
    <div
      ref={hostRef}
      aria-hidden
      className="fixed inset-0 z-0 pointer-events-none"
    />
  )
}
