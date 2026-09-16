export interface ServiceEventSink {
  /** Returns true when at least one renderer accepted the event. */
  send(channel: string, payload: unknown): boolean
}

export const NULL_EVENT_SINK: ServiceEventSink = {
  send: () => false
}
