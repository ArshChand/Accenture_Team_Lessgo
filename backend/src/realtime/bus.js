/**
 * Late-bound handle on the socket emitter, so HTTP routes can push an event
 * without the app having to be constructed after the socket server. Until the
 * server binds one, emits are dropped — which is what tests want.
 */
let emitter = null;

export function bindEmitter(emit) {
  emitter = emit;
}

export function emit(event, payload) {
  emitter?.(event, payload);
}
