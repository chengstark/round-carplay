const GUIDE_SEGMENTS = [
  { color: '#38d05b', path: 'M 425 390 L 365 555' },
  { color: '#38d05b', path: 'M 575 390 L 635 555' },
  { color: '#38d05b', path: 'M 365 555 Q 500 525 635 555' },
  { color: '#ffd43b', path: 'M 365 555 L 285 720' },
  { color: '#ffd43b', path: 'M 635 555 L 715 720' },
  { color: '#ffd43b', path: 'M 285 720 Q 500 665 715 720' },
  { color: '#ef3f3f', path: 'M 285 720 L 180 880' },
  { color: '#ef3f3f', path: 'M 715 720 L 820 880' },
  { color: '#ef3f3f', path: 'M 180 880 Q 500 790 820 880' }
] as const

/**
 * Fixed parking guides shared by the USB and Wi-Fi backup-camera views.
 * These are visual distance references only; they intentionally do not move
 * with steering input. The viewBox keeps the geometry proportional at every
 * display size while pointer-events:none leaves camera controls tappable.
 */
export default function ParkingGuides(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 1000 1000"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 2,
        width: '100%',
        height: '100%',
        pointerEvents: 'none'
      }}
    >
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        {GUIDE_SEGMENTS.map(({ path }, index) => (
          <path
            key={`outline-${index}`}
            d={path}
            stroke="rgba(0,0,0,0.72)"
            strokeWidth="22"
          />
        ))}
        {GUIDE_SEGMENTS.map(({ color, path }, index) => (
          <path key={`guide-${index}`} d={path} stroke={color} strokeWidth="11" />
        ))}
      </g>
    </svg>
  )
}
