import { useCallback, useEffect, useRef, useState } from 'react'
import { Peer } from 'peerjs'
import type { DataConnection, PeerError } from 'peerjs'

export type PeerRole = 'solo' | 'host' | 'client'
export type PeerStatus = 'idle' | 'connecting' | 'connected' | 'error'

type Options = {
  // Called for every message received from another peer.
  onMessage: (msg: unknown) => void
  // Host-only: a new client just finished connecting (good time to push state).
  onClientJoin: () => void
}

// Prefix keeps our room ids from colliding with other apps on the public broker.
const ROOM_PREFIX = 'qwixx-room-'
// Unambiguous charset (no 0/O, 1/I) so codes are easy to read out loud.
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
// How long to wait for the broker / peer handshake before giving up.
const CONNECT_TIMEOUT_MS = 12000

const LOG = '[peer]'

// ICE servers for NAT traversal. STUN discovers a peer's public address; TURN
// relays traffic when no direct path can be found — which includes restrictive
// networks AND same-machine setups where browsers hide host candidates behind
// mDNS. The TURN relay (incl. TCP/443) is what makes the negotiation actually
// succeed when ICE would otherwise fail.
const PEER_OPTIONS = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
      {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
    ],
  },
}

function randomCode() {
  let code = ''
  for (let i = 0; i < 4; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
  }
  return code
}

export function usePeerSync({ onMessage, onClientJoin }: Options) {
  const [role, setRole] = useState<PeerRole>('solo')
  const [status, setStatus] = useState<PeerStatus>('idle')
  const [roomCode, setRoomCode] = useState<string | null>(null)
  const [peerCount, setPeerCount] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const peerRef = useRef<Peer | null>(null)
  // Host: every connected client. Client: a single entry for the host.
  const connectionsRef = useRef<DataConnection[]>([])

  // Keep the latest callbacks in refs so the long-lived PeerJS event handlers
  // (registered once) always call the current closure instead of a stale one.
  const onMessageRef = useRef(onMessage)
  const onClientJoinRef = useRef(onClientJoin)
  useEffect(() => {
    onMessageRef.current = onMessage
    onClientJoinRef.current = onClientJoin
  })

  const teardown = useCallback(() => {
    connectionsRef.current.forEach((conn) => conn.close())
    connectionsRef.current = []
    peerRef.current?.destroy()
    peerRef.current = null
    setPeerCount(0)
  }, [])

  const leave = useCallback(() => {
    console.log(LOG, 'leaving')
    teardown()
    setRole('solo')
    setStatus('idle')
    setRoomCode(null)
    setError(null)
  }, [teardown])

  const dropConnection = useCallback((conn: DataConnection) => {
    connectionsRef.current = connectionsRef.current.filter((c) => c !== conn)
    setPeerCount(connectionsRef.current.length)
  }, [])

  // Host side: wire up a freshly accepted client connection.
  const registerHostConnection = useCallback(
    (conn: DataConnection) => {
      conn.on('open', () => {
        console.log(LOG, 'host: client connected', conn.peer)
        setPeerCount(connectionsRef.current.length)
        onClientJoinRef.current()
      })
      conn.on('data', (data) => onMessageRef.current(data))
      conn.on('close', () => {
        console.log(LOG, 'host: client left', conn.peer)
        dropConnection(conn)
      })
      conn.on('error', (err) => {
        console.warn(LOG, 'host: connection error', err)
        dropConnection(conn)
      })
    },
    [dropConnection],
  )

  const createRoom = useCallback(() => {
    teardown()
    setRole('host')
    setStatus('connecting')
    setError(null)

    const attempt = (triesLeft: number) => {
      const code = randomCode()
      const id = ROOM_PREFIX + code
      console.log(LOG, 'host: registering id', id)
      const peer = new Peer(id, PEER_OPTIONS)
      peerRef.current = peer
      let opened = false

      peer.on('open', () => {
        opened = true
        console.log(LOG, 'host: broker open, room code', code)
        setRoomCode(code)
        setStatus('connected')
      })

      peer.on('connection', (conn) => {
        console.log(LOG, 'host: client connecting', conn.peer)
        connectionsRef.current.push(conn)
        registerHostConnection(conn)
      })

      // The broker socket can drop without the peer being dead — reconnect.
      peer.on('disconnected', () => {
        if (peerRef.current === peer && !peer.destroyed) {
          console.warn(LOG, 'host: broker disconnected, reconnecting')
          peer.reconnect()
        }
      })

      peer.on('error', (err: PeerError<string>) => {
        // The (extremely unlikely) chance our random code is taken: try again.
        if (err.type === 'unavailable-id' && triesLeft > 0) {
          console.warn(LOG, 'host: id taken, retrying with a new code')
          peer.destroy()
          attempt(triesLeft - 1)
          return
        }
        console.error(LOG, 'host: error', err.type, err.message)
        if (!opened) {
          setError(`Connection failed (${err.type}).`)
          setStatus('error')
        }
      })

      setTimeout(() => {
        if (!opened && peerRef.current === peer) {
          console.error(LOG, 'host: broker timed out')
          setError('Could not reach the connection server. Check your network and try again.')
          setStatus('error')
        }
      }, CONNECT_TIMEOUT_MS)
    }

    attempt(5)
  }, [teardown, registerHostConnection])

  const joinRoom = useCallback(
    (rawCode: string) => {
      teardown()
      const code = rawCode.trim().toUpperCase()
      if (!code) {
        setError('Enter a room code to join.')
        setStatus('error')
        setRole('solo')
        return
      }
      setRole('client')
      setStatus('connecting')
      setError(null)

      console.log(LOG, 'client: creating peer to join', code)
      const peer = new Peer(PEER_OPTIONS)
      peerRef.current = peer
      let connected = false

      peer.on('open', (id) => {
        console.log(LOG, 'client: broker open as', id, '- dialing host')
        // Reliable + ordered delivery so full-state messages always arrive.
        const conn = peer.connect(ROOM_PREFIX + code, { reliable: true })
        connectionsRef.current = [conn]
        conn.on('open', () => {
          connected = true
          console.log(LOG, 'client: connected to host')
          setRoomCode(code)
          setStatus('connected')
          setPeerCount(1)
        })
        conn.on('data', (data) => onMessageRef.current(data))
        conn.on('close', () => {
          console.warn(LOG, 'client: connection closed')
          if (peerRef.current === peer) {
            setStatus('error')
            setError('Disconnected from the room.')
          }
        })
        conn.on('error', (err) => {
          console.error(LOG, 'client: connection error', err)
          if (peerRef.current === peer) {
            setStatus('error')
            setError('Lost connection to the room.')
          }
        })
      })

      peer.on('error', (err: PeerError<string>) => {
        console.error(LOG, 'client: error', err.type, err.message)
        if (!connected) {
          setError(
            err.type === 'peer-unavailable'
              ? `No room found for code "${code}".`
              : `Connection failed (${err.type}).`,
          )
          setStatus('error')
        }
      })

      setTimeout(() => {
        if (!connected && peerRef.current === peer) {
          console.error(LOG, 'client: connection timed out')
          setError(`Couldn't reach room "${code}". Check the code and your network.`)
          setStatus('error')
        }
      }, CONNECT_TIMEOUT_MS)
    },
    [teardown],
  )

  // Host: broadcast to all clients. Client: send to the host. Solo: no-op.
  const send = useCallback((msg: unknown) => {
    connectionsRef.current.forEach((conn) => {
      if (conn.open) conn.send(msg)
    })
  }, [])

  // NOTE: intentionally no "destroy on unmount" effect. This hook lives at the
  // app root (which never really unmounts), and such an effect's cleanup fires
  // during React StrictMode's dev mount→unmount→remount cycle, destroying a
  // peer that an auto-join just created. Cleanup is handled explicitly by leave().

  return {
    role,
    status,
    roomCode,
    peerCount,
    error,
    createRoom,
    joinRoom,
    leave,
    send,
  }
}
