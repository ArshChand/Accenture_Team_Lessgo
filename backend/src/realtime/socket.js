import { Server } from 'socket.io';

/**
 * Socket.IO wiring for the live queue.
 *
 * A single `/queue` namespace with per-zone rooms: a large hospital running
 * separate paediatric and adult EDs can watch just their own zone without
 * filtering every event client-side. The default zone is `main`, which is all
 * this prototype's seed data uses, so nothing here requires multiple zones to be
 * useful today — it is the seam a multi-zone deployment plugs into.
 *
 * Every event this server emits is also named in the polling fallback's response
 * shape (see routes/queue.js), so a client can be written once against "the
 * queue changed" and not care which transport delivered it.
 */
export function createSocketServer(httpServer, { corsOrigin = '*' } = {}) {
  const io = new Server(httpServer, {
    cors: { origin: corsOrigin, methods: ['GET', 'POST'] },
  });

  const queueNs = io.of('/queue');

  queueNs.on('connection', (socket) => {
    const zone = socket.handshake.query?.zone || 'main';
    socket.join(zone);
    socket.join('all'); // department-wide events (surge state) reach everyone

    socket.on('disconnect', () => {
      /* no per-connection state to clean up */
    });
  });

  return {
    io,
    /** Emit to every connected dashboard, regardless of zone. */
    emit(event, payload) {
      queueNs.to('all').emit(event, payload);
    },
  };
}
