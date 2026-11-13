import { Fragment } from 'react'
import type { NavigationViewState } from '../playport/protocol'
import { arrivalTime, navigationApp, remainingTrip, tripDistance } from '../playport/navigation'

export default function NavigationTrip({ navigation }: { navigation?: NavigationViewState }): React.JSX.Element | null {
  if (!navigation?.active) return null
  const arrival = arrivalTime(navigation.estimatedArrival)
  const remaining = [
    { field: 'remaining', label: 'Time remaining', value: remainingTrip(navigation.timeRemainingSeconds) },
    { field: 'distance', label: 'Distance remaining', value: tripDistance(navigation) }
  ].filter((item): item is { field: string; label: string; value: string } => item.value !== null)
  if (!arrival && !remaining.length) return null
  const app = navigationApp(navigation.sourceName)
  return (
    <aside className="navigation-trip" aria-label="Navigation trip information" data-navigation-app={app}>
      {navigation.sourceName && <span className="navigation-source">{navigation.sourceName}</span>}
      {arrival && <div className="navigation-trip-arrival"><strong>{arrival}</strong><small>arrival</small></div>}
      {remaining.length > 0 && <div className="navigation-trip-remaining">
        {remaining.map((item, index) => <Fragment key={item.field}>
          {index > 0 && <span className="navigation-trip-separator" aria-hidden="true">·</span>}
          <span aria-label={`${item.label}: ${item.value}`}>{item.value}</span>
        </Fragment>)}
      </div>}
    </aside>
  )
}
